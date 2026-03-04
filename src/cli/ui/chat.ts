import * as readline from "node:readline";
import type { CoworkRole, ForgeState, ProviderKind, TaskStatus } from "../types";
import { saveState } from "../core/state";
import { PROVIDERS, fetchModels, setApiKeyInConfig, setProvider } from "../providers/manager";
import { runAiTurn } from "../agent/chatAgent";
import { runCommand } from "../terminal/exec";
import {
  addArtifact,
  addTask,
  loadWorkspace,
  memoryDigest,
  rememberTurn,
  saveWorkspace,
  setObjective,
  setRoleOwner,
  setTaskStatus,
  workspaceDigest
} from "../core/cowork";
import { appendTurn, ChatSession, createChat, renameChat, resolveChat } from "../core/chats";
import { upsertChat } from "../core/chats";

const USE_ANSI = Boolean(process.stdout.isTTY);
const C = {
  reset: USE_ANSI ? "\x1b[0m" : "",
  dim: USE_ANSI ? "\x1b[2m" : "",
  gray: USE_ANSI ? "\x1b[90m" : "",
  blue: USE_ANSI ? "\x1b[34m" : "",
  cyan: USE_ANSI ? "\x1b[36m" : "",
  green: USE_ANSI ? "\x1b[32m" : "",
  yellow: USE_ANSI ? "\x1b[33m" : "",
  white: USE_ANSI ? "\x1b[97m" : "",
  underline: USE_ANSI ? "\x1b[4m" : ""
} as const;

interface ChatContext {
  state: ForgeState;
  modelSuggestions: string[];
  workspace: Awaited<ReturnType<typeof loadWorkspace>>;
  chat: ChatSession;
}

const COMMANDS = [
  "/help",
  "/exit",
  "/status",
  "/providers",
  "/provider",
  "/models",
  "/model",
  "/apikey",
  "/mode",
  "/yolo",
  "/root",
  "/endpoint",
  "/browserpath",
  "/searchmode",
  "/autocontinue",
  "/config",
  "/objective",
  "/task",
  "/artifact",
  "/timeline",
  "/roles",
  "/memory",
  "/rename",
  "/clear"
];

export async function runInteractiveChat(initialState: ForgeState, opts?: { resume?: string }): Promise<void> {
  const workspace = await loadWorkspace(initialState.projectRoot);
  const resumed = opts?.resume ? await resolveChat(opts.resume) : null;
  const chat = resumed || (await createChat());
  const ctx: ChatContext = { state: initialState, modelSuggestions: [], workspace, chat };
  let activeTurnAbort: AbortController | null = null;
  let activeSpinner: { stop: () => void } | null = null;
  let chatDirty = false;
  let shellMode = false;
  const promptPrefix = () => (shellMode ? "sh> " : "you> ");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 300,
    completer: (line: string) => completeLine(line, ctx)
  });
  const stopLiveSuggestions = enableLiveSuggestions(rl, ctx, promptPrefix);
  const stopEscAbort = enableEscAbort(() => {
    if (!activeTurnAbort || activeTurnAbort.signal.aborted) return;
    activeTurnAbort.abort();
    if (activeSpinner) activeSpinner.stop();
    process.stdout.write("\n[stopping ai response...]\n");
  });
  const stopCtrlYToggle = enableCtrlYToggle(async () => {
    ctx.state = {
      ...ctx.state,
      executionMode: (ctx.state.executionMode || "safe") === "yolo" ? "safe" : "yolo"
    };
    await saveState(ctx.state);
    process.stdout.write(`\nmode=${ctx.state.executionMode} (toggled via Ctrl+Y)\n`);
    redrawPrompt(rl, promptPrefix());
  });
  const stopShiftTabToggle = enableShiftTabToggle(() => {
    shellMode = !shellMode;
    process.stdout.write(`\ninput-mode=${shellMode ? "shell" : "chat"} (toggled via Shift+Tab)\n`);
    redrawPrompt(rl, promptPrefix());
  });
  const autosaveTimer = setInterval(async () => {
    if (!chatDirty) return;
    try {
      await upsertChat(ctx.chat);
      chatDirty = false;
    } catch {
      // best effort autosave
    }
  }, 4000);

  renderHeader(ctx.state);
  if (resumed) {
    console.log(`resumed chat: id=${ctx.chat.id} name=${ctx.chat.name}`);
    if (ctx.chat.turns.length) {
      console.log(`history (${ctx.chat.turns.length} turns):`);
      for (const turn of ctx.chat.turns.slice(-80)) {
        const prefix = turn.role === "assistant" ? "ai>" : "you>";
        console.log(`${prefix} ${turn.content}`);
      }
    } else {
      console.log("history: (empty)");
    }
  } else {
    console.log(`new chat: id=${ctx.chat.id} name=${ctx.chat.name}`);
  }

  if (!ctx.state.onboardingComplete) {
    await runConfigWizard(rl, ctx);
  }

  await autoRefreshModels(ctx);

  while (true) {
    const line = await question(rl, promptPrefix());
    const input = line.trim();
    if (!input) continue;

    if (input.startsWith("/")) {
      const shouldExit = await handleSlash(input, ctx, rl);
      if (shouldExit) break;
      continue;
    }

    if (shellMode) {
      try {
        const r = await runCommand(input, ctx.state.projectRoot);
        if (r.output?.trim()) process.stdout.write(`${r.output.trimEnd()}\n`);
        process.stdout.write(`exit=${r.code}\n`);
      } catch (err) {
        console.error(`error> ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    try {
      // Save user message immediately so it survives long-running/aborted turns.
      await appendTurn(ctx.chat.id, "user", input);
      ctx.chat.turns.push({ ts: new Date().toISOString(), role: "user", content: input });
      ctx.chat.updatedAt = new Date().toISOString();
      chatDirty = true;

      activeTurnAbort = new AbortController();
      const spinner = createSpinner("ai");
      activeSpinner = spinner;
      spinner.start();
      let printedToolBlock = false;
      try {
        const response = await runAiTurn(ctx.state, input, {
          signal: activeTurnAbort.signal,
          workspaceContext: workspaceDigest(ctx.workspace),
          memoryContext: memoryDigest(ctx.workspace),
          confirmAction: async (tool, args) => {
            if ((ctx.state.executionMode || "safe") === "yolo") return true;
            spinner.pause();
            const ans = (await question(rl, `${C.yellow}confirm${C.reset} ${tool} ${JSON.stringify(args)} ? [y/N]: `))
              .trim()
              .toLowerCase();
            spinner.resume();
            return ans === "y" || ans === "yes";
          },
          onStatus: (status) => spinner.setLabel(`ai ${status}`),
          onToolCall: (tool, args) => {
            spinner.pause();
            if (!printedToolBlock) {
              process.stdout.write(`\n${C.dim}${"-".repeat(72)}${C.reset}\n`);
              printedToolBlock = true;
            }
            process.stdout.write(`${C.cyan}• Ran${C.reset} ${formatToolCall(tool, args)}\n${C.gray}  └${C.reset}\n`);
            spinner.resume();
          },
          onToolResult: (tool, resultPreview) => {
            spinner.pause();
            process.stdout.write(`${C.gray}    > ${compactLine(resultPreview)}${C.reset}\n`);
            spinner.resume();
          }
        });
        spinner.stop();
        process.stdout.write("\r\x1b[2K");
        if (printedToolBlock) process.stdout.write(`${C.dim}${"-".repeat(72)}${C.reset}\n`);
        process.stdout.write(`${C.green}ai>${C.reset} ${C.white}${response}${C.reset}\n`);
        await appendTurn(ctx.chat.id, "assistant", response);
        ctx.chat.turns.push({ ts: new Date().toISOString(), role: "assistant", content: response });
        ctx.chat.updatedAt = new Date().toISOString();
        chatDirty = true;
        ctx.workspace = rememberTurn(ctx.workspace, input, response);
        await saveWorkspace(ctx.workspace);
      } finally {
        spinner.stop();
        activeSpinner = null;
      }
    } catch (err) {
      console.error(`error> ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      activeTurnAbort = null;
    }
  }

  rl.close();
  stopLiveSuggestions();
  stopEscAbort();
  stopCtrlYToggle();
  stopShiftTabToggle();
  clearInterval(autosaveTimer);
  if (chatDirty) {
    try {
      await upsertChat(ctx.chat);
    } catch {
      // best effort final save
    }
  }
  console.log(`to resume this chat use: forge resume ${ctx.chat.name}`);
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function createSpinner(initialLabel: string): {
  start: () => void;
  stop: () => void;
  setLabel: (label: string) => void;
  pause: () => void;
  resume: () => void;
} {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let timer: NodeJS.Timeout | null = null;
  let active = false;
  let paused = false;
  let label = initialLabel;

  const draw = () => {
    if (!active || paused) return;
    const f = frames[i++ % frames.length];
    process.stdout.write(`\r${C.yellow}${f}${C.reset} ${C.dim}${label}${C.reset}`);
  };

  return {
    start() {
      if (!process.stdout.isTTY) return;
      if (active) return;
      active = true;
      draw();
      timer = setInterval(draw, 80);
    },
    stop() {
      if (!process.stdout.isTTY) return;
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      process.stdout.write(`\r${C.reset}\x1b[2K`);
    },
    setLabel(next: string) {
      label = next;
    },
    pause() {
      if (!process.stdout.isTTY) return;
      paused = true;
      process.stdout.write(`\r${C.reset}\x1b[2K`);
    },
    resume() {
      paused = false;
      draw();
    }
  };
}

function formatToolCall(tool: string, args: Record<string, unknown>): string {
  const json = JSON.stringify(args || {});
  const compact = json.length > 140 ? `${json.slice(0, 140)}...` : json;
  return `\`${tool}\` ${compact}`;
}

function compactLine(input: string): string {
  const oneLine = String(input || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "(ok)";
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}...` : oneLine;
}

async function handleSlash(input: string, ctx: ChatContext, rl: readline.Interface): Promise<boolean> {
  const [cmd, ...args] = input.split(/\s+/);

  if (cmd === "/help") {
    printHelp();
    return false;
  }

  if (cmd === "/exit") return true;

  if (cmd === "/clear") {
    console.clear();
    renderHeader(ctx.state);
    return false;
  }

  if (cmd === "/rename") {
    const nextName = args.join(" ").trim();
    if (!nextName) {
      console.log("usage: /rename <chat-name>");
      return false;
    }
    const renamed = await renameChat(ctx.chat.id, nextName);
    if (!renamed) {
      console.log("rename failed");
      return false;
    }
    ctx.chat = renamed;
    console.log(`chat renamed: ${ctx.chat.name}`);
    return false;
  }

  if (cmd === "/status") {
    printStatus(ctx.state, ctx.modelSuggestions.length);
    console.log(
      JSON.stringify(
        {
          objective: ctx.workspace.objective.text || null,
          tasks: ctx.workspace.tasks.length,
          artifacts: ctx.workspace.artifacts.length,
          history: ctx.workspace.history.length,
          memorySummary: ctx.workspace.memory.summary || null,
          lastIntent: ctx.workspace.memory.lastIntent || null,
          recentMemoryTurns: ctx.workspace.memory.recentTurns.length
        },
        null,
        2
      )
    );
    return false;
  }

  if (cmd === "/config") {
    await runConfigWizard(rl, ctx);
    return false;
  }

  if (cmd === "/providers") {
    console.log(`providers: ${PROVIDERS.join(", ")}`);
    return false;
  }

  if (cmd === "/provider") {
    const provider = args[0] as ProviderKind | undefined;
    if (!provider || !PROVIDERS.includes(provider)) {
      console.log(`usage: /provider <${PROVIDERS.join("|")}>`);
      return false;
    }
    ctx.state = setProvider(ctx.state, {
      ...ctx.state.provider,
      provider
    });
    await saveState(ctx.state);
    console.log(`provider set: ${provider}`);
    await autoRefreshModels(ctx);
    return false;
  }

  if (cmd === "/models") {
    if (args[0] === "refresh") {
      await autoRefreshModels(ctx);
      return false;
    }
    if (!ctx.modelSuggestions.length) {
      console.log("no cached models; run /models refresh");
    } else {
      console.log(ctx.modelSuggestions.slice(0, 120).join("\n"));
    }
    return false;
  }

  if (cmd === "/model") {
    const model = args.join(" ").trim();
    if (!model) {
      console.log("usage: /model <model-id>");
      return false;
    }
    ctx.state = setProvider(ctx.state, { ...ctx.state.provider, model });
    await saveState(ctx.state);
    console.log(`model set: ${model}`);
    return false;
  }

  if (cmd === "/apikey") {
    const maybeProvider = args[0] as ProviderKind | undefined;
    if (maybeProvider && PROVIDERS.includes(maybeProvider) && args[1]) {
      ctx.state = setApiKeyInConfig(ctx.state, maybeProvider, args.slice(1).join(" "));
      await saveState(ctx.state);
      console.log(`api key saved for ${maybeProvider}`);
      if (maybeProvider === ctx.state.provider.provider) await autoRefreshModels(ctx);
      return false;
    }

    if (args[0]) {
      const current = ctx.state.provider.provider;
      ctx.state = setApiKeyInConfig(ctx.state, current, args.join(" "));
      await saveState(ctx.state);
      console.log(`api key saved for ${current}`);
      await autoRefreshModels(ctx);
      return false;
    }

    console.log("usage: /apikey <key> OR /apikey <provider> <key>");
    return false;
  }

  if (cmd === "/mode") {
    const mode = (args[0] || "").trim().toLowerCase();
    if (!mode) {
      console.log(`mode=${ctx.state.executionMode || "safe"}`);
      console.log("usage: /mode <safe|yolo>");
      return false;
    }
    if (mode !== "safe" && mode !== "yolo") {
      console.log("usage: /mode <safe|yolo>");
      return false;
    }
    ctx.state = { ...ctx.state, executionMode: mode as "safe" | "yolo" };
    await saveState(ctx.state);
    console.log(`mode=${mode}`);
    return false;
  }

  if (cmd === "/yolo") {
    const value = (args[0] || "").trim().toLowerCase();
    if (!value) {
      ctx.state = {
        ...ctx.state,
        executionMode: (ctx.state.executionMode || "safe") === "yolo" ? "safe" : "yolo"
      };
      await saveState(ctx.state);
      console.log(`mode=${ctx.state.executionMode}`);
      return false;
    }
    if (!["on", "off", "true", "false", "toggle"].includes(value)) {
      console.log("usage: /yolo [on|off|toggle]");
      return false;
    }
    if (value === "toggle") {
      ctx.state = {
        ...ctx.state,
        executionMode: (ctx.state.executionMode || "safe") === "yolo" ? "safe" : "yolo"
      };
    } else {
      const enabled = value === "on" || value === "true";
      ctx.state = { ...ctx.state, executionMode: enabled ? "yolo" : "safe" };
    }
    await saveState(ctx.state);
    console.log(`mode=${ctx.state.executionMode}`);
    return false;
  }

  if (cmd === "/root") {
    const root = args.join(" ").trim();
    if (!root) {
      console.log("usage: /root <path>");
      return false;
    }
    ctx.state = { ...ctx.state, projectRoot: root };
    await saveState(ctx.state);
    ctx.workspace = await loadWorkspace(ctx.state.projectRoot);
    console.log(`projectRoot=${root}`);
    return false;
  }

  if (cmd === "/endpoint") {
    const endpoint = args.join(" ").trim();
    if (!endpoint) {
      console.log("usage: /endpoint <url>");
      return false;
    }
    ctx.state = setProvider(ctx.state, { ...ctx.state.provider, endpoint });
    await saveState(ctx.state);
    console.log(`endpoint=${endpoint}`);
    return false;
  }

  if (cmd === "/browserpath") {
    const browserExecutablePath = args.join(" ").trim();
    if (!browserExecutablePath) {
      console.log(`browserpath=${ctx.state.browserExecutablePath || "not set"}`);
      console.log("usage: /browserpath </path/to/chrome-or-brave>");
      return false;
    }
    ctx.state = { ...ctx.state, browserExecutablePath };
    await saveState(ctx.state);
    console.log(`browserpath=${browserExecutablePath}`);
    return false;
  }

  if (cmd === "/searchmode") {
    const mode = (args[0] || "").toLowerCase();
    if (!mode) {
      console.log(`searchmode=${ctx.state.searchMode || "safe"}`);
      console.log("usage: /searchmode <safe|manual>");
      return false;
    }
    if (mode !== "safe" && mode !== "manual") {
      console.log("usage: /searchmode <safe|manual>");
      return false;
    }
    ctx.state = { ...ctx.state, searchMode: mode as "safe" | "manual" };
    await saveState(ctx.state);
    console.log(`searchmode=${mode}`);
    return false;
  }

  if (cmd === "/autocontinue") {
    const raw = (args[0] || "").trim();
    if (!raw) {
      console.log(`autocontinue=${ctx.state.autoContinueMax ?? 20}`);
      console.log("usage: /autocontinue <1-120>");
      return false;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 120) {
      console.log("usage: /autocontinue <1-120>");
      return false;
    }
    ctx.state = { ...ctx.state, autoContinueMax: Math.floor(n) };
    await saveState(ctx.state);
    console.log(`autocontinue=${ctx.state.autoContinueMax}`);
    return false;
  }

  if (cmd === "/objective") {
    if (!args.length || args[0] === "show") {
      console.log(ctx.workspace.objective.text || "(objective not set)");
      return false;
    }
    const text = args.join(" ").trim();
    if (!text) {
      console.log("usage: /objective <text> | /objective show");
      return false;
    }
    ctx.workspace = setObjective(ctx.workspace, text);
    await saveWorkspace(ctx.workspace);
    console.log("objective updated");
    return false;
  }

  if (cmd === "/task") {
    const sub = args[0];
    if (sub === "add") {
      const title = args.slice(1).join(" ").trim();
      if (!title) {
        console.log("usage: /task add <title>");
        return false;
      }
      ctx.workspace = addTask(ctx.workspace, title, "planner");
      await saveWorkspace(ctx.workspace);
      console.log(`task added: ${ctx.workspace.tasks[ctx.workspace.tasks.length - 1].id}`);
      return false;
    }
    if (sub === "list" || !sub) {
      const statusFilter = (args[1] as TaskStatus | undefined) || "";
      const tasks = statusFilter ? ctx.workspace.tasks.filter((t) => t.status === statusFilter) : ctx.workspace.tasks;
      if (!tasks.length) console.log("(no tasks)");
      for (const t of tasks.slice(-120)) {
        console.log(`${t.id} [${t.status}] (${t.ownerRole}) ${t.title}`);
      }
      return false;
    }
    if (sub === "approve" || sub === "start" || sub === "review" || sub === "complete" || sub === "archive") {
      const id = args[1];
      if (!id) {
        console.log(`usage: /task ${sub} <taskId>`);
        return false;
      }
      const statusBySub: Record<string, TaskStatus> = {
        approve: "approved",
        start: "in_progress",
        review: "under_review",
        complete: "completed",
        archive: "archived"
      };
      try {
        ctx.workspace = setTaskStatus(ctx.workspace, id, statusBySub[sub], args.slice(2).join(" "));
        await saveWorkspace(ctx.workspace);
        console.log(`task ${id} => ${statusBySub[sub]}`);
      } catch (err) {
        console.log(`task update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
    console.log("usage: /task <add|list|approve|start|review|complete|archive> ...");
    return false;
  }

  if (cmd === "/artifact") {
    const sub = args[0];
    if (sub === "list" || !sub) {
      const list = ctx.workspace.artifacts.slice(-120);
      if (!list.length) console.log("(no artifacts)");
      for (const a of list) console.log(`${a.id} task=${a.taskId} type=${a.type} ref=${a.ref}`);
      return false;
    }
    if (sub === "add") {
      const taskId = args[1];
      const type = args[2];
      const ref = args.slice(3).join(" ").trim();
      if (!taskId || !type || !ref) {
        console.log("usage: /artifact add <taskId> <type> <ref>");
        return false;
      }
      try {
        ctx.workspace = addArtifact(ctx.workspace, taskId, type, ref);
        await saveWorkspace(ctx.workspace);
        console.log("artifact added");
      } catch (err) {
        console.log(`artifact add failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
    console.log("usage: /artifact <add|list> ...");
    return false;
  }

  if (cmd === "/timeline") {
    const recent = ctx.workspace.history.slice(-120);
    if (!recent.length) {
      console.log("(no history)");
      return false;
    }
    for (const e of recent) console.log(`${e.ts} ${e.kind}: ${e.detail}`);
    return false;
  }

  if (cmd === "/roles") {
    const sub = args[0];
    if (!sub || sub === "show") {
      console.log(JSON.stringify(ctx.workspace.roles, null, 2));
      return false;
    }
    if (sub === "set") {
      const role = args[1] as CoworkRole | undefined;
      const owner = args.slice(2).join(" ").trim();
      if (!role || !["architect", "planner", "executor", "reviewer", "memory_manager"].includes(role) || !owner) {
        console.log("usage: /roles set <architect|planner|executor|reviewer|memory_manager> <owner>");
        return false;
      }
      ctx.workspace = setRoleOwner(ctx.workspace, role, owner);
      await saveWorkspace(ctx.workspace);
      console.log(`role ${role} => ${owner}`);
      return false;
    }
    console.log("usage: /roles [show] | /roles set <role> <owner>");
    return false;
  }

  if (cmd === "/memory") {
    const sub = args[0];
    if (!sub || sub === "show") {
      console.log(memoryDigest(ctx.workspace));
      return false;
    }
    if (sub === "clear") {
      ctx.workspace = {
        ...ctx.workspace,
        memory: {
          summary: "",
          lastIntent: "",
          recentTurns: []
        }
      };
      await saveWorkspace(ctx.workspace);
      console.log("memory cleared");
      return false;
    }
    console.log("usage: /memory [show|clear]");
    return false;
  }

  console.log(`unknown command: ${cmd}. use /help`);
  return false;
}

async function autoRefreshModels(ctx: ChatContext): Promise<void> {
  try {
    const models = await fetchModels(ctx.state, ctx.state.provider.provider);
    ctx.modelSuggestions = models;
    if (models.length && !models.includes(ctx.state.provider.model)) {
      ctx.state = setProvider(ctx.state, { ...ctx.state.provider, model: models[0] });
      await saveState(ctx.state);
      console.log(`model auto-selected: ${models[0]}`);
    }
    console.log(`models cached: ${models.length}`);
  } catch (err) {
    ctx.modelSuggestions = [];
    console.log(`models refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function completeLine(line: string, ctx: ChatContext): [string[], string] {
  const trimmed = line.trimStart();

  if (!trimmed.startsWith("/")) return [[], line];

  if (trimmed === "/provider" || trimmed === "/provider ") {
    return [PROVIDERS, ""];
  }
  if (trimmed === "/model" || trimmed === "/model ") {
    return [ctx.modelSuggestions, ""];
  }
  if (trimmed === "/mode" || trimmed === "/mode ") return [["safe", "yolo"], ""];
  if (trimmed === "/yolo" || trimmed === "/yolo ") return [["on", "off", "toggle"], ""];
  if (trimmed === "/task" || trimmed === "/task ") {
    return [["add", "list", "approve", "start", "review", "complete", "archive"], ""];
  }
  if (trimmed === "/artifact" || trimmed === "/artifact ") {
    return [["add", "list"], ""];
  }
  if (trimmed === "/roles" || trimmed === "/roles ") {
    return [["show", "set"], ""];
  }
  if (trimmed === "/searchmode" || trimmed === "/searchmode ") {
    return [["safe", "manual"], ""];
  }
  if (trimmed === "/autocontinue" || trimmed === "/autocontinue ") {
    return [["20", "40", "60", "120"], ""];
  }
  if (trimmed === "/memory" || trimmed === "/memory ") {
    return [["show", "clear"], ""];
  }
  if (trimmed === "/rename" || trimmed === "/rename ") return [["my-chat"], ""];

  const tokens = trimmed.split(/\s+/);
  const current = tokens[tokens.length - 1] || "";

  if (tokens.length === 1) {
    return [COMMANDS.filter((c) => c.startsWith(current)), line];
  }

  if (tokens[0] === "/provider") {
    return [PROVIDERS.filter((p) => p.startsWith(current)), current];
  }

  if (tokens[0] === "/model") {
    return [ctx.modelSuggestions.filter((m) => m.startsWith(current)), current];
  }

  if (tokens[0] === "/mode" && tokens.length === 2) return [["safe", "yolo"].filter((m) => m.startsWith(current)), current];
  if (tokens[0] === "/yolo" && tokens.length === 2) return [["on", "off", "toggle"].filter((m) => m.startsWith(current)), current];

  if (tokens[0] === "/apikey" && tokens.length === 2) {
    return [PROVIDERS.filter((p) => p.startsWith(current)), current];
  }

  if (tokens[0] === "/models" && tokens.length === 2) {
    return [["refresh"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/task" && tokens.length === 2) {
    return [["add", "list", "approve", "start", "review", "complete", "archive"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/roles" && tokens.length === 2) {
    return [["show", "set"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/roles" && tokens[1] === "set" && tokens.length === 3) {
    return [["architect", "planner", "executor", "reviewer", "memory_manager"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/memory" && tokens.length === 2) {
    return [["show", "clear"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/searchmode" && tokens.length === 2) {
    return [["safe", "manual"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/autocontinue" && tokens.length === 2) {
    return [["20", "40", "60", "120"].filter((v) => v.startsWith(current)), current];
  }

  return [[], current];
}

function enableLiveSuggestions(rl: readline.Interface, ctx: ChatContext, getPromptPrefix: () => string): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => {};

  readline.emitKeypressEvents(input);

  const onKeypress = (_str: string, key: { name?: string }) => {
    const line = rl.line || "";
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("/")) return;

    const suffix = ghostSuffix(line, trimmed, ctx);
    if (!suffix) return;

    // Accept suggestion using Right Arrow or End key.
    if (key?.name === "right" || key?.name === "end") {
      const cursor = (rl as any).cursor ?? line.length;
      if (cursor >= line.length) {
        rl.write(suffix);
        return;
      }
    }

    process.stdout.write(`\r${getPromptPrefix()}${line}\x1b[90m${suffix}\x1b[0m`);
    process.stdout.write(`\x1b[${suffix.length}D`);
  };

  input.on("keypress", onKeypress);
  return () => input.off("keypress", onKeypress);
}

function enableEscAbort(onAbort: () => void): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => {};

  readline.emitKeypressEvents(input);
  const onKeypress = (_str: string, key: { name?: string; sequence?: string }) => {
    if (key?.name === "escape" || key?.sequence === "\u001b") onAbort();
  };

  input.on("keypress", onKeypress);
  return () => input.off("keypress", onKeypress);
}

function enableCtrlYToggle(onToggle: () => void | Promise<void>): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => {};

  readline.emitKeypressEvents(input);
  const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
    if (key?.ctrl && key?.name === "y") void onToggle();
  };

  input.on("keypress", onKeypress);
  return () => input.off("keypress", onKeypress);
}

function enableShiftTabToggle(onToggle: () => void): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => {};

  readline.emitKeypressEvents(input);
  const onKeypress = (_str: string, key: { name?: string; shift?: boolean }) => {
    if (key?.name === "tab" && key?.shift) onToggle();
  };

  input.on("keypress", onKeypress);
  return () => input.off("keypress", onKeypress);
}

function redrawPrompt(rl: readline.Interface, prompt = "you> "): void {
  process.stdout.write(`\r\x1b[2K${prompt}${rl.line}`);
}

function ghostSuffix(line: string, trimmed: string, ctx: ChatContext): string {
  const [suggestions, current] = completeLine(trimmed, ctx);
  const first = suggestions[0];
  if (!first) return "";

  // Case: `/model` or `/provider` completed command without value yet.
  if (current === "") {
    if (line.endsWith(" ")) return first;
    return ` ${first}`;
  }

  // Normal prefix completion for current token.
  if (first.startsWith(current)) {
    return first.slice(current.length);
  }

  return "";
}

function renderHeader(state: ForgeState): void {
  const width = 96;
  const inner = width - 4;
  const lines = [
    "Cognautic Forge Interactive Chat",
    `provider=${state.provider.provider} model=${state.provider.model} mode=${state.executionMode || "safe"} searchmode=${state.searchMode || "safe"} autocontinue=${state.autoContinueMax ?? 20}`,
    `root=${state.projectRoot}`,
    "Type /help for commands. Press Right/End for ghost autocomplete.",
    `Discord: ${C.blue}${C.underline}https://discord.gg/QrfpWDuZqd${C.reset}`,
    `Instagram: ${C.blue}${C.underline}https://www.instagram.com/cognautic/${C.reset}`
  ];

  const borderTop = `╭${"─".repeat(width - 2)}╮`;
  const borderMid = `├${"─".repeat(width - 2)}┤`;
  const borderBottom = `╰${"─".repeat(width - 2)}╯`;

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  const boxLine = (s: string) => {
    const plain = stripAnsi(s);
    if (plain.length <= inner) {
      return `${C.blue}│${C.reset} ${s}${" ".repeat(inner - plain.length)} ${C.blue}│${C.reset}`;
    }
    // For overflow lines, truncate by visible width to preserve border alignment.
    return `${C.blue}│${C.reset} ${plain.slice(0, inner)} ${C.blue}│${C.reset}`;
  };

  console.log(`${C.blue}${borderTop}${C.reset}`);
  console.log(boxLine(lines[0]));
  console.log(`${C.blue}${borderMid}${C.reset}`);
  for (const line of lines.slice(1)) console.log(boxLine(line));
  console.log(`${C.blue}${borderBottom}${C.reset}`);
}

function printStatus(state: ForgeState, modelCount: number): void {
  console.log(JSON.stringify({
    provider: state.provider,
    executionMode: state.executionMode || "safe",
    searchMode: state.searchMode || "safe",
    autoContinueMax: state.autoContinueMax ?? 20,
    browserExecutablePath: state.browserExecutablePath || null,
    projectRoot: state.projectRoot,
    permissions: state.permissions,
    modelSuggestions: modelCount
  }, null, 2));
}

function printHelp(): void {
  console.log([
    "/help",
    "/exit",
    "/clear",
    "/status",
    "/providers",
    "/provider <name>",
    "/models [refresh]",
    "/model <id>",
    "/apikey <key>",
    "/apikey <provider> <key>",
    "/endpoint <url> (for custom provider)",
    "/browserpath </usr/sbin/brave>",
    "/searchmode <safe|manual>",
    "/autocontinue <1-120>",
    "/config (guided setup wizard)",
    "/mode <safe|yolo>",
    "/yolo [on|off|toggle] (shortcut: Ctrl+Y)",
    "/root <path>",
    "/objective <text> | /objective show",
    "/task <add|list|approve|start|review|complete|archive> ...",
    "/artifact <add|list> ...",
    "/timeline",
    "/roles [show] | /roles set <role> <owner>",
    "/memory [show|clear]",
    "/rename <chat-name>",
    "Shift+Tab toggles input mode: chat <-> shell",
    "<any non-/ text> sends a chat prompt"
  ].join("\n"));
}

async function runConfigWizard(rl: readline.Interface, ctx: ChatContext): Promise<void> {
  console.log("Config wizard: press Enter to keep current value.");

  const providerInput = (await question(
    rl,
    `Provider [${PROVIDERS.join(", ")}] (${ctx.state.provider.provider}): `
  )).trim();
  if (providerInput && PROVIDERS.includes(providerInput as ProviderKind)) {
    ctx.state = setProvider(ctx.state, { ...ctx.state.provider, provider: providerInput as ProviderKind });
  }

  if (ctx.state.provider.provider !== "ollama") {
    const keyInput = (await question(rl, `API key for ${ctx.state.provider.provider} (stored in config): `)).trim();
    if (keyInput) {
      ctx.state = setApiKeyInConfig(ctx.state, ctx.state.provider.provider, keyInput);
    }
  } else {
    console.log("Ollama selected: API key not required.");
  }

  const endpointInput = (await question(
    rl,
    `Endpoint (${ctx.state.provider.endpoint || (ctx.state.provider.provider === "ollama" ? "http://127.0.0.1:11434" : "none")}): `
  )).trim();
  if (endpointInput) {
    ctx.state = setProvider(ctx.state, { ...ctx.state.provider, endpoint: endpointInput });
  }

  const browserPathInput = (await question(
    rl,
    `Browser executable path (${ctx.state.browserExecutablePath || "default playwright chromium"}): `
  )).trim();
  if (browserPathInput) {
    ctx.state = { ...ctx.state, browserExecutablePath: browserPathInput };
  }

  const searchModeInput = (await question(
    rl,
    `Search mode [safe/manual] (${ctx.state.searchMode || "safe"}): `
  )).trim().toLowerCase();
  if (searchModeInput === "safe" || searchModeInput === "manual") {
    ctx.state = { ...ctx.state, searchMode: searchModeInput };
  }

  const autoContinueInput = (await question(
    rl,
    `Auto-continue max steps [1-120] (${ctx.state.autoContinueMax ?? 20}): `
  )).trim();
  if (autoContinueInput) {
    const n = Number(autoContinueInput);
    if (Number.isFinite(n) && n >= 1 && n <= 120) {
      ctx.state = { ...ctx.state, autoContinueMax: Math.floor(n) };
    }
  }

  await saveState(ctx.state);
  await autoRefreshModels(ctx);

  if (ctx.modelSuggestions.length) {
    const current = ctx.state.provider.model;
    const shown = ctx.modelSuggestions.slice(0, 20);
    console.log("Available models:");
    shown.forEach((m, i) => console.log(`${i + 1}. ${m}`));

    const modelInput = (await question(rl, `Model (${current}): `)).trim();
    if (modelInput) {
      const idx = Number(modelInput);
      const next = Number.isInteger(idx) && idx >= 1 && idx <= shown.length ? shown[idx - 1] : modelInput;
      ctx.state = setProvider(ctx.state, { ...ctx.state.provider, model: next });
    }
  }

  const rootInput = (await question(rl, `Project root (${ctx.state.projectRoot}): `)).trim();
  if (rootInput) {
    ctx.state = { ...ctx.state, projectRoot: rootInput };
    ctx.workspace = await loadWorkspace(ctx.state.projectRoot);
  }

  const modeInput = (await question(rl, `Execution mode [safe/yolo] (${ctx.state.executionMode || "safe"}): `))
    .trim()
    .toLowerCase();
  if (modeInput === "safe" || modeInput === "yolo") {
    ctx.state = { ...ctx.state, executionMode: modeInput };
  }

  ctx.state = { ...ctx.state, onboardingComplete: true };
  await saveState(ctx.state);
  console.log("Config saved.");
}
