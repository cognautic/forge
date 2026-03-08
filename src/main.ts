#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgv } from "./cli/core/args";
import { loadDotEnv } from "./cli/core/env";
import { HELP } from "./cli/core/help";
import { loadState, resetForgeState, saveState } from "./cli/core/state";
import type { ProviderKind } from "./cli/types";
import { fetchModels, setApiKeyInConfig, setProvider } from "./cli/providers/manager";
import { listFiles, readWorkspaceFile, writeWorkspaceFile } from "./cli/core/filesystem";
import { runCommand } from "./cli/terminal/exec";
import { launchBrowser, navigate, click, extract, evaluate } from "./cli/browser/playwright";
import { moveMouse, clickMouse, typeText, shortcut, emergencyStop } from "./cli/input/controller";
import { runAgent } from "./cli/agent/loop";
import { streamCompletion } from "./cli/providers/client";
import { runInteractiveChat } from "./cli/ui/chat";
import { listMcpTools } from "./cli/mcp/client";
import {
  addTask,
  loadWorkspace,
  memoryDigest,
  rememberTurn,
  saveWorkspace,
  setObjective,
  setTaskStatus,
  workspaceDigest
} from "./cli/core/cowork";
import { runAiTurn } from "./cli/agent/chatAgent";
import { GoogleIntegration } from "./integrations/google";

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

  if (args.includes("-v") || args.includes("--version")) {
    print(await readVersion());
    return;
  }

  if (args.includes("--reset")) {
    await resetForgeState();
    print("Forge state reset. Removed ~/.config/cognautic-forge");
    return;
  }

  let state = await loadState();
  state = { ...state, projectRoot: process.cwd() };
  await saveState(state);

  if (args.length === 0) {
    await runInteractiveChat(state);
    return;
  }

  const parsed = parseArgv(args);

  if (parsed.command === "reset") {
    await resetForgeState();
    print("Forge state reset. Removed ~/.config/cognautic-forge");
    return;
  }

  if (parsed.command === "resume") {
    const selector = [parsed.subcommand, ...parsed.rest].filter(Boolean).join(" ").trim();
    if (!selector) throw new Error("Usage: resume <chat-id|name>");
    await runInteractiveChat(state, { resume: selector });
    return;
  }

  if (parsed.command === "help" || parsed.command === "--help") {
    print(HELP);
    return;
  }

  if (parsed.command === "state" && parsed.subcommand === "show") {
    print(state);
    return;
  }

  if (parsed.command === "state" && parsed.subcommand === "set-root") {
    const root = parsed.rest[0];
    if (!root) throw new Error("Missing path");
    state = { ...state, projectRoot: root };
    await saveState(state);
    print(`projectRoot=${root}`);
    return;
  }

  if (parsed.command === "state" && parsed.subcommand === "set-browser") {
    const browserExecutablePath = parsed.rest.join(" ").trim();
    if (!browserExecutablePath) throw new Error("Missing browser executable path");
    state = { ...state, browserExecutablePath };
    await saveState(state);
    print(`browserExecutablePath=${browserExecutablePath}`);
    return;
  }

  if (parsed.command === "provider" && parsed.subcommand === "show") {
    print(state.provider);
    return;
  }

  if (parsed.command === "provider" && parsed.subcommand === "set") {
    const provider = parsed.rest[0] as ProviderKind | undefined;
    const model = parsed.rest[1];
    if (!provider || !model) throw new Error("Usage: provider set <provider> <model> [--endpoint URL]");
    state = setProvider(state, { provider, model, endpoint: parsed.flags.endpoint as string | undefined });
    await saveState(state);
    print(state.provider);
    return;
  }

  if (parsed.command === "provider" && parsed.subcommand === "key") {
    if (parsed.rest[0] !== "set") throw new Error("Usage: provider key set <provider> <api-key>");
    const provider = parsed.rest[1] as ProviderKind | undefined;
    const key = parsed.rest[2];
    if (!provider || !key) throw new Error("Usage: provider key set <provider> <api-key>");
    state = setApiKeyInConfig(state, provider, key);
    await saveState(state);
    print(`stored api key for ${provider}`);
    return;
  }

  if (parsed.command === "provider" && parsed.subcommand === "models") {
    const provider = (parsed.rest[0] as ProviderKind | undefined) || state.provider.provider;
    print(await fetchModels(state, provider));
    return;
  }

  if (parsed.command === "mcp" && parsed.subcommand === "list") {
    print({
      servers: state.mcpServers || [],
      tools: await listMcpTools(state)
    });
    return;
  }

  if (parsed.command === "mcp" && parsed.subcommand === "add") {
    const [name, command, ...cmdArgs] = parsed.rest;
    if (!name || !command) throw new Error("Usage: mcp add <name> <command> [args...]");
    const next = [...(state.mcpServers || []).filter((item) => item.name !== name), { name, command, args: cmdArgs }];
    state = { ...state, mcpServers: next };
    await saveState(state);
    print(`mcp server saved: ${name}`);
    return;
  }

  if (parsed.command === "mcp" && parsed.subcommand === "remove") {
    const name = parsed.rest[0];
    if (!name) throw new Error("Usage: mcp remove <name>");
    state = { ...state, mcpServers: (state.mcpServers || []).filter((item) => item.name !== name) };
    await saveState(state);
    print(`mcp server removed: ${name}`);
    return;
  }

  if (parsed.command === "auth" && parsed.subcommand === "google") {
    const google = new GoogleIntegration();
    const result = await google.connect(getGoogleUserId(), ["gmail", "calendar", "drive", "docs", "sheets", "tasks", "contacts", "meet"]);
    print(result.success ? `google connected: ${result.email}` : `google auth failed: ${result.error}`);
    return;
  }

  if (parsed.command === "logout" && parsed.subcommand === "google") {
    const google = new GoogleIntegration();
    try {
      await google.disconnect(getGoogleUserId());
      print("google disconnected");
    } catch (error) {
      print(`google logout failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (parsed.command === "files" && parsed.subcommand === "list") {
    const limit = Number(parsed.flags.limit ?? 200);
    print(await listFiles(state.projectRoot, limit));
    return;
  }

  if (parsed.command === "files" && parsed.subcommand === "read") {
    const path = parsed.rest[0];
    if (!path) throw new Error("Missing path");
    print(await readWorkspaceFile(state.projectRoot, path));
    return;
  }

  if (parsed.command === "files" && parsed.subcommand === "write") {
    const [path, ...contentParts] = parsed.rest;
    if (!path) throw new Error("Missing path");
    await writeWorkspaceFile(state.projectRoot, path, contentParts.join(" "));
    print(`wrote ${path}`);
    return;
  }

  if (parsed.command === "exec" && parsed.subcommand === "run") {
    const cmd = parsed.rest.join(" ");
    if (!cmd) throw new Error("Missing command");
    const result = await runCommand(cmd, state.projectRoot);
    print({ code: result.code });
    return;
  }

  if (parsed.command === "browser" && parsed.subcommand === "launch") {
    await launchBrowser(
      (parsed.flags.dir as string) || ".forge-data/browser",
      (parsed.flags.executable as string) || state.browserExecutablePath
    );
    print("browser launched");
    return;
  }

  if (parsed.command === "browser" && parsed.subcommand === "goto") {
    await navigate(parsed.rest[0] || "https://example.com");
    print("ok");
    return;
  }

  if (parsed.command === "browser" && parsed.subcommand === "click") {
    await click(parsed.rest[0] || "body");
    print("ok");
    return;
  }

  if (parsed.command === "browser" && parsed.subcommand === "extract") {
    print(await extract(parsed.rest[0] || "body"));
    return;
  }

  if (parsed.command === "browser" && parsed.subcommand === "eval") {
    print(await evaluate(parsed.rest.join(" ") || "document.title"));
    return;
  }

  if (parsed.command === "input") {
    if (parsed.subcommand === "move") return print(moveMouse(Number(parsed.rest[0]), Number(parsed.rest[1])));
    if (parsed.subcommand === "click") return print(clickMouse((parsed.rest[0] as "left" | "right" | "middle") || "left"));
    if (parsed.subcommand === "type") return print(typeText(parsed.rest.join(" ")));
    if (parsed.subcommand === "shortcut") return print(shortcut((parsed.rest[0] || "CTRL+K").split("+")));
    if (parsed.subcommand === "stop") return print(emergencyStop());
  }

  if (parsed.command === "agent" && parsed.subcommand === "run") {
    const task = parsed.rest.join(" ");
    if (!task) throw new Error("Missing task");
    print(await runAgent(state, { task, maxSteps: Number(parsed.flags.maxSteps ?? 5) }));
    return;
  }

  if (parsed.command === "chat") {
    const prompt = [parsed.subcommand, ...parsed.rest].filter(Boolean).join(" ");
    if (!prompt) throw new Error("Missing prompt");
    await streamCompletion(state, prompt, (chunk) => process.stdout.write(chunk));
    process.stdout.write("\n");
    return;
  }

  if (parsed.command === "ai-turn") {
    const prompt = [parsed.subcommand, ...parsed.rest].filter(Boolean).join(" ").trim();
    if (!prompt) throw new Error("Missing prompt");
    const ws = await loadWorkspace(state.projectRoot);
    const response = await runAiTurn(state, prompt, {
      workspaceContext: workspaceDigest(ws),
      memoryContext: memoryDigest(ws)
    });
    const next = rememberTurn(ws, prompt, response);
    await saveWorkspace(next);
    print(response);
    return;
  }

  if (parsed.command === "ai-turn-trace") {
    const prompt = [parsed.subcommand, ...parsed.rest].filter(Boolean).join(" ").trim();
    if (!prompt) throw new Error("Missing prompt");
    const ws = await loadWorkspace(state.projectRoot);
    const tools: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];
    const response = await runAiTurn(state, prompt, {
      workspaceContext: workspaceDigest(ws),
      memoryContext: memoryDigest(ws),
      onToolCall: (tool, args) => {
        tools.push({ tool, args, result: "" });
      },
      onToolResult: (tool, resultPreview) => {
        const idx = [...tools].reverse().findIndex((t) => t.tool === tool && !t.result);
        if (idx >= 0) {
          const pos = tools.length - 1 - idx;
          tools[pos] = { ...tools[pos], result: resultPreview };
        } else {
          tools.push({ tool, args: {}, result: resultPreview });
        }
      }
    });
    const next = rememberTurn(ws, prompt, response);
    await saveWorkspace(next);
    print({ response, tools });
    return;
  }

  if (parsed.command === "workspace" && parsed.subcommand === "show") {
    const ws = await loadWorkspace(state.projectRoot);
    print(workspaceDigest(ws));
    return;
  }

  if (parsed.command === "workspace" && parsed.subcommand === "objective") {
    const text = parsed.rest.join(" ").trim();
    if (!text) throw new Error("Usage: workspace objective <text>");
    let ws = await loadWorkspace(state.projectRoot);
    ws = setObjective(ws, text);
    await saveWorkspace(ws);
    print("objective updated");
    return;
  }

  if (parsed.command === "workspace" && parsed.subcommand === "task") {
    const action = parsed.rest[0];
    let ws = await loadWorkspace(state.projectRoot);
    if (action === "add") {
      const title = parsed.rest.slice(1).join(" ").trim();
      if (!title) throw new Error("Usage: workspace task add <title>");
      ws = addTask(ws, title, "planner");
      await saveWorkspace(ws);
      print(ws.tasks[ws.tasks.length - 1]);
      return;
    }
    if (action === "list") {
      print(ws.tasks);
      return;
    }
    if (action === "set") {
      const id = parsed.rest[1];
      const status = parsed.rest[2] as any;
      if (!id || !status) throw new Error("Usage: workspace task set <id> <status>");
      ws = setTaskStatus(ws, id, status);
      await saveWorkspace(ws);
      print(`task ${id} => ${status}`);
      return;
    }
    throw new Error("Usage: workspace task <add|list|set> ...");
  }

  print(HELP);
}

async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(join(__dirname, "../package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return String(pkg?.version || "unknown");
  } catch {
    return "unknown";
  }
}

function getGoogleUserId(): string {
  return (
    process.env.FORGE_GOOGLE_USER_ID ||
    process.env.USER ||
    process.env.USERNAME ||
    "default"
  );
}

main().catch((err) => {
  console.error(`[forge:error] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
