import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ForgeState, McpServerConfig } from "../types";

type PendingRequest = { resolve: (value: any) => void; reject: (err: Error) => void };
const MCP_INIT_TIMEOUT_MS = 60000;
const MCP_LIST_TIMEOUT_MS = 30000;
const MCP_CALL_TIMEOUT_MS = 60000;
const MCP_DISCOVERY_RETRY_COOLDOWN_MS = 30000;
const MCP_TOOL_CACHE_TTL_MS = 60000;
const discoveryFailureUntil = new Map<string, number>();
const toolCache = new Map<string, { expiresAt: number; tools: McpToolDescriptor[] }>();
const pendingDiscovery = new Map<string, Promise<McpToolDescriptor[]>>();
const serverDiagnostics = new Map<string, { ok: boolean; tools: number; message: string }>();

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

export function getEffectiveMcpServers(state: ForgeState): McpServerConfig[] {
  return [...(state.mcpServers || [])];
}

function serverCacheKey(server: McpServerConfig): string {
  return JSON.stringify({
    name: server.name,
    command: server.command,
    args: server.args || [],
    env: server.env || {}
  });
}

async function discoverServerTools(server: McpServerConfig): Promise<McpToolDescriptor[]> {
  const cacheKey = serverCacheKey(server);
  const cached = toolCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tools;
  }
  const inFlight = pendingDiscovery.get(cacheKey);
  if (inFlight) return await inFlight;

  const run = (async () => {
    const blockedUntil = discoveryFailureUntil.get(server.name) || 0;
    if (blockedUntil > Date.now()) return [];
    try {
      const result = await withSession(server, async (session) =>
        await withTimeout(
          session.request("tools/list", {}),
          MCP_LIST_TIMEOUT_MS,
          () => `MCP tools/list timeout for ${server.name}.${session.errorContext()}`
        )
      );
      const listed = Array.isArray(result?.tools) ? result.tools : [];
      const tools = listed
        .map((tool: unknown) => ({
          server: server.name,
          name: String((tool as { name?: unknown })?.name || "").trim(),
          description: (tool as { description?: unknown })?.description
            ? String((tool as { description?: unknown }).description)
            : undefined,
          inputSchema: (tool as { inputSchema?: unknown })?.inputSchema
        }))
        .filter((tool: McpToolDescriptor) => tool.name);
      discoveryFailureUntil.delete(server.name);
      toolCache.set(cacheKey, { expiresAt: Date.now() + MCP_TOOL_CACHE_TTL_MS, tools });
      serverDiagnostics.set(server.name, {
        ok: true,
        tools: tools.length,
        message: tools.length ? `${tools.length} tools` : "connected but exposed 0 tools"
      });
      return tools;
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool discovery failed";
      discoveryFailureUntil.set(server.name, Date.now() + MCP_DISCOVERY_RETRY_COOLDOWN_MS);
      serverDiagnostics.set(server.name, { ok: false, tools: 0, message });
      return [];
    } finally {
      pendingDiscovery.delete(cacheKey);
    }
  })();

  pendingDiscovery.set(cacheKey, run);
  return await run;
}

export async function prewarmMcpServers(
  state: ForgeState,
  onProgress?: (info: { total: number; completed: number; server: string; tools: number; ok: boolean; message: string }) => void
): Promise<McpToolDescriptor[]> {
  const servers = getEffectiveMcpServers(state);
  const all: McpToolDescriptor[] = [];
  let completed = 0;
  await Promise.all(servers.map(async (server) => {
    const tools = await discoverServerTools(server);
    all.push(...tools);
    completed += 1;
    const diagnostic = serverDiagnostics.get(server.name) || { ok: tools.length > 0, tools: tools.length, message: tools.length ? `${tools.length} tools` : "0 tools" };
    onProgress?.({ total: servers.length, completed, server: server.name, tools: tools.length, ok: diagnostic.ok, message: diagnostic.message });
  }));
  return all;
}

export function getMcpDiagnostics(state: ForgeState): Array<{ server: string; ok: boolean; tools: number; message: string }> {
  return getEffectiveMcpServers(state).map((server) => {
    const diagnostic = serverDiagnostics.get(server.name);
    return {
      server: server.name,
      ok: diagnostic?.ok ?? false,
      tools: diagnostic?.tools ?? 0,
      message: diagnostic?.message ?? "not warmed yet"
    };
  });
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
  for (const server of getEffectiveMcpServers(state)) {
    tools.push(...await discoverServerTools(server));
  }
  return tools.filter((tool) => tool.name);
}

export async function callMcpTool(
  state: ForgeState,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const server = getEffectiveMcpServers(state).find((item) => item.name === serverName);
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
