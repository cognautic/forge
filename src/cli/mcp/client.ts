import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ForgeState, McpServerConfig } from "../types";

type PendingRequest = { resolve: (value: any) => void; reject: (err: Error) => void };
const MCP_INIT_TIMEOUT_MS = 20000;
const MCP_LIST_TIMEOUT_MS = 10000;
const MCP_CALL_TIMEOUT_MS = 30000;

export type McpToolDescriptor = {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
};

class StdioMcpSession {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private stderrTail = "";

  constructor(private readonly config: McpServerConfig) {
    this.child = spawn(config.command, config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(config.env || {}) }
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail += chunk.toString("utf8");
      if (this.stderrTail.length > 4000) this.stderrTail = this.stderrTail.slice(-4000);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "forge", version: "0.0.6" }
    });
    this.notify("notifications/initialized", {});
  }

  async request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.child.kill();
  }

  errorContext(): string {
    const tail = this.stderrTail.trim();
    return tail ? ` stderr=${tail.slice(-500)}` : "";
  }

  private send(payload: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lenMatch) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const len = Number(lenMatch[1]);
      const total = headerEnd + 4 + len;
      if (this.buffer.length < total) return;
      const body = this.buffer.slice(headerEnd + 4, total).toString("utf8");
      this.buffer = this.buffer.slice(total);
      this.onMessage(body);
    }
  }

  private onMessage(body: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof parsed?.id !== "number") return;
    const waiter = this.pending.get(parsed.id);
    if (!waiter) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      waiter.reject(new Error(parsed.error.message || `MCP error ${parsed.error.code || "unknown"}`));
      return;
    }
    waiter.resolve(parsed.result);
  }
}

async function withSession<T>(server: McpServerConfig, fn: (session: StdioMcpSession) => Promise<T>): Promise<T> {
  const session = new StdioMcpSession(server);
  try {
    await withTimeout(
      session.initialize(),
      MCP_INIT_TIMEOUT_MS,
      () => `MCP initialize timeout for ${server.name}.${session.errorContext()}`
    );
    return await fn(session);
  } finally {
    session.close();
  }
}

export async function listMcpTools(state: ForgeState): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = [];
  for (const server of state.mcpServers || []) {
    try {
      const result = await withSession(server, async (session) =>
        await withTimeout(
          session.request("tools/list", {}),
          MCP_LIST_TIMEOUT_MS,
          () => `MCP tools/list timeout for ${server.name}.${session.errorContext()}`
        )
      );
      const listed = Array.isArray(result?.tools) ? result.tools : [];
      for (const tool of listed) {
        tools.push({
          server: server.name,
          name: String(tool?.name || "").trim(),
          description: tool?.description ? String(tool.description) : undefined,
          inputSchema: tool?.inputSchema
        });
      }
    } catch {
      // Ignore unreachable servers during discovery.
    }
  }
  return tools.filter((tool) => tool.name);
}

export async function callMcpTool(
  state: ForgeState,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const server = (state.mcpServers || []).find((item) => item.name === serverName);
  if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
  const result = await withSession(server, async (session) =>
    await withTimeout(
      session.request("tools/call", { name: toolName, arguments: args || {} }),
      MCP_CALL_TIMEOUT_MS,
      () => `MCP tools/call timeout for ${server.name}.${toolName}.${session.errorContext()}`
    )
  );
  return JSON.stringify(result);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string | (() => string)): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(typeof message === "function" ? message() : message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
