import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CoworkRole, ForgeState, ProviderKind, TaskStatus } from "../types";
import { saveState } from "../core/state";
import { PROVIDERS, fetchModels, setApiKeyInConfig, setProvider } from "../providers/manager";
import { runAiTurn } from "../agent/chatAgent";
import { runCommand } from "../terminal/exec";
import { getEffectiveMcpServers, getMcpDiagnostics, listMcpTools, prewarmMcpServers } from "../mcp/client";
import { GoogleIntegration } from "../../integrations/google";
import {
  addArtifact,
  addTask,
  loadWorkspace,
  saveWorkspace,
  setObjective,
  setRoleOwner,
  setTaskStatus,
} from "../core/cowork";
import { appendTurn, ChatSession, ChatTurn, createChat, renameChat, resolveChat } from "../core/chats";
import { upsertChat } from "../core/chats";

import { TerminalCompositor } from "./compositor";

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
  sessionMemory: ChatTurn[];
}

type PasteMode = "idle" | "receiving_paste" | "staged_multiline";
type PendingAttachment = { token: string; kind: "text" | "image"; text: string; mime?: string; bytes?: number };
type PlanStatus = "pending" | "in_progress" | "completed";
type UiPlanStep = { step: string; status: PlanStatus };
type PackageMeta = { name: string; version: string };

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
  "/config",
  "/objective",
  "/task",
  "/artifact",
  "/timeline",
  "/roles",
  "/memory",
  "/mcp",
  "/auth",
  "/logout",
  "/rename",
  "/clear"
];

export async function runInteractiveChat(initialState: ForgeState, opts?: { resume?: string }): Promise<void> {
  const compositor = TerminalCompositor.getInstance();
  const workspace = await loadWorkspace(initialState.projectRoot);
  const resumed = opts?.resume ? await resolveChat(opts.resume) : null;
  const chat = resumed || (await createChat());
  const ctx: ChatContext = { state: initialState, modelSuggestions: [], workspace, chat, sessionMemory: [...chat.turns] };
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
  compositor.setReadline(rl);
  
  const pasteState: { mode: PasteMode } = { mode: "idle" };
  let suppressQueuedPasteLines = 0;
  let pendingTextPasteToken: string | null = null;
  let pendingAttachments: PendingAttachment[] = [];
  let pendingImagePastes: Array<{ path: string; mime: string; bytes: number }> = [];
  let imagePasteBusy = false;
  let modalPromptActive = false;
  let lastSubmittedInput = "";
  let lastSubmittedAt = 0;
  let currentPlan: { explanation?: string; steps: UiPlanStep[] } | null = null;

  const onMasterKeypress = async (str: string, key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string }) => {
    // 1. Image Paste (Ctrl+V)
    if (key?.ctrl && key?.name === "v") {
      if (!imagePasteBusy && process.stdin.isTTY) {
        imagePasteBusy = true;
        try {
          const pasted = await pasteImageFromClipboard(ctx.state.projectRoot);
          if (pasted) {
            pendingImagePastes.push(pasted);
            const token = `[pasted image ${basename(pasted.path)}]`;
            pendingAttachments.push({ token, kind: "image", text: pasted.path, mime: pasted.mime, bytes: pasted.bytes });
            insertPlaceholderToken(rl, token, promptPrefix());
            if (!modalPromptActive) redrawPrompt(rl, promptPrefix());
          }
        } finally {
          imagePasteBusy = false;
        }
      }
      return;
    }

    // 2. YOLO Toggle (Ctrl+Y)
    if (key?.ctrl && key?.name === "y") {
      ctx.state = {
        ...ctx.state,
        executionMode: (ctx.state.executionMode || "safe") === "yolo" ? "safe" : "yolo"
      };
      await saveState(ctx.state);
      process.stdout.write(`\nmode=${ctx.state.executionMode} (toggled via Ctrl+Y)\n`);
      if (!modalPromptActive) redrawPrompt(rl, promptPrefix());
      return;
    }

    // 3. Mode Toggle (Shift+Tab)
    if (key?.name === "tab" && key?.shift) {
      shellMode = !shellMode;
      process.stdout.write(`\ninput-mode=${shellMode ? "shell" : "chat"} (toggled via Shift+Tab)\n`);
      if (!modalPromptActive) redrawPrompt(rl, promptPrefix());
      return;
    }

    // 4. PageUp -> Up
    if (key?.name === "pageup") {
      rl.write(null, { name: "up" });
      return;
    }

    // 5. Esc/Ctrl+C Abort logic is now handled globally by the compositor in thinking mode.
    // Here we just handle redraws and ghost redraws.

    // 6. Ghost Suggestions & Autocomplete
    if (!modalPromptActive && key?.name !== "return" && key?.name !== "enter") {
      const line = rl.line || "";
      const trimmed = line.trimStart();
      const suffix = trimmed.startsWith("/") ? ghostSuffix(line, trimmed, ctx) : "";

      // Accept suggestion using Right Arrow or End key.
      if (suffix && (key?.name === "right" || key?.name === "enter")) {
        const cursor = (rl as any).cursor ?? line.length;
        if (cursor >= line.length) {
          rl.write(suffix);
          return;
        }
      }

      // Live redraw with ghost text
      const prompt = promptPrefix();
      const cursor = Math.max(0, Math.min((rl as any).cursor ?? line.length, line.length));
      const moveLeft = (line.length - cursor) + (suffix ? suffix.length : 0);
      process.stdout.write("\r\x1b[2K");
      if (suffix) {
        process.stdout.write(`${prompt}${line}\x1b[90m${suffix}\x1b[0m`);
        if (moveLeft > 0) process.stdout.write(`\x1b[${moveLeft}D`);
      } else {
        process.stdout.write(`${prompt}${line}`);
        if (moveLeft > 0) process.stdout.write(`\x1b[${moveLeft}D`);
      }
    }
  };

  compositor.on("keypress", onMasterKeypress);

  const stopPasteIndicator = enablePasteIndicator(({ phase, chars, text, multiline, echoedRows, lineCount }) => {
    if (phase === "receiving_paste") {
      if (pasteState.mode === "idle") pasteState.mode = "receiving_paste";
      return;
    }
    if (typeof chars !== "number" || typeof text !== "string") {
      if (pasteState.mode === "receiving_paste") pasteState.mode = "idle";
      return;
    }

    if (!multiline) {
      pasteState.mode = "idle";
      return;
    }

    const token = `[pasted ${chars} chars]`;
    pendingAttachments.push({ token, kind: "text", text });
    insertPlaceholderToken(rl, token, promptPrefix());
    pasteState.mode = "idle";
    suppressQueuedPasteLines = Math.max(0, (lineCount ?? 0) + 1);
  });

  let autosaveInFlight: Promise<void> | null = null;
  const flushChat = async () => {
    if (!chatDirty) return;
    if (autosaveInFlight) return autosaveInFlight;
    autosaveInFlight = (async () => {
      try {
        await upsertChat(ctx.chat);
        chatDirty = false;
      } catch {
        // best effort autosave
      } finally {
        autosaveInFlight = null;
      }
    })();
    return autosaveInFlight;
  };
  const autosaveTimer = setInterval(async () => {
    await flushChat();
  }, 4000);

  const updateInfo = await checkForNpmUpdate();
  renderHeader(ctx.state);
  if (updateInfo) renderUpdateBanner(updateInfo.current, updateInfo.latest, updateInfo.name);
  const effectiveMcpServers = getEffectiveMcpServers(ctx.state);
  if (effectiveMcpServers.length) {
    console.log(`${C.gray}mcp> loading ${effectiveMcpServers.length} servers in background...${C.reset}`);
    void prewarmMcpServers(ctx.state, ({ completed, total, server, tools, ok, message }) => {
      const status = ok ? `${tools} tools` : `failed`;
      process.stdout.write(`\r\x1b[2K${C.gray}mcp> ${completed}/${total} ${server} ${status}${C.reset}\n`);
      redrawPrompt(rl, promptPrefix());
    }).then((tools) => {
      const serverCount = effectiveMcpServers.length;
      process.stdout.write(`\r\x1b[2K${C.gray}mcp ready: ${serverCount} servers, ${tools.length} tools${C.reset}\n`);
      for (const diagnostic of getMcpDiagnostics(ctx.state)) {
        if (!diagnostic.ok || diagnostic.tools === 0) {
          process.stdout.write(`\r\x1b[2K${C.gray}mcp! ${diagnostic.server}: ${diagnostic.message}${C.reset}\n`);
        }
      }
      redrawPrompt(rl, promptPrefix());
    }).catch(() => {
      process.stdout.write(`\r\x1b[2K${C.gray}mcp warmup skipped${C.reset}\n`);
      redrawPrompt(rl, promptPrefix());
    });
  }
  if (resumed) {
    if (ctx.chat.turns.length) {
      for (const turn of ctx.chat.turns.slice(-80)) {
        if (turn.role === "user") {
          renderMessageBox("you", turn.content, "user");
        } else {
          console.log(`ai> ${turn.content}`);
        }
      }
    }
  }

  if (!ctx.state.onboardingComplete) {
    await runConfigWizard(rl, ctx);
  } else {
    await autoRefreshModels(ctx);
  }

  while (true) {
    if (suppressQueuedPasteLines > 0) {
      await question(rl, "");
      suppressQueuedPasteLines--;
      if (suppressQueuedPasteLines === 0) {
        if (pendingTextPasteToken) {
          insertPlaceholderToken(rl, pendingTextPasteToken, promptPrefix());
          pendingTextPasteToken = null;
        }
      }
      redrawPrompt(rl, promptPrefix());
      continue;
    }

    const source = await question(rl, promptPrefix());
    (rl as any).line = "";
    (rl as any).cursor = 0;
    pendingAttachments = pendingAttachments.filter((att) => source.includes(att.token));
    const input = source
      .replace(/\[pasted [^\]]+\]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!input) continue;
    const now = Date.now();
    if (input === lastSubmittedInput && now - lastSubmittedAt < 450) continue;
    lastSubmittedInput = input;
    lastSubmittedAt = now;
    if (await processInput(input)) {
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[2K");
      }
      rl.pause();
      break;
    }
  }

  async function processInput(input: string): Promise<boolean> {
    if (input.startsWith("/")) {
      const shouldExit = await handleSlash(input, ctx, rl);
      return shouldExit;
    }

    if (shellMode) {
      try {
        const r = await runCommand(input, ctx.state.projectRoot);
        if (r.output?.trim()) process.stdout.write(`${r.output.trimEnd()}\n`);
        process.stdout.write(`exit=${r.code}\n`);
      } catch (err) {
        console.error(`error> ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }

    const textAttachments = pendingAttachments.filter((a) => a.kind === "text");
    const imageAttachments = pendingAttachments.filter((a) => a.kind === "image");
    const finalInput = [
      input,
      textAttachments.length
        ? `\nPasted text blocks:\n${textAttachments.map((a, i) => `--- block ${i + 1} ---\n${a.text}`).join("\n")}`
        : "",
      imageAttachments.length
        ? `\nAttached images:\n${imageAttachments.map((a) => `- ${a.text} (${a.mime || "image/*"}, ${a.bytes || 0} bytes)`).join("\n")}`
        : ""
    ].filter(Boolean).join("\n\n");
    pendingImagePastes = [];
    pendingAttachments = [];

    try {
      rl.pause();
      // Keep stdin flowing so ESC/Ctrl+C detection continues even while
      // readline is paused (rl.pause() internally pauses process.stdin).
      if (process.stdin.isTTY && process.stdin.isPaused()) {
        process.stdin.resume();
      }
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[1A\r\x1b[2K");
      }
      // Save user message immediately so it survives long-running/aborted turns.
      await appendTurn(ctx.chat.id, "user", finalInput);
      ctx.chat.turns.push({ ts: new Date().toISOString(), role: "user", content: finalInput });
      ctx.sessionMemory.push({ ts: new Date().toISOString(), role: "user", content: finalInput });
      ctx.chat.updatedAt = new Date().toISOString();
      chatDirty = true;
      renderMessageBox("you", finalInput, "user");

      activeTurnAbort = new AbortController();
      compositor.enterThinking(() => {
        if (activeTurnAbort && !activeTurnAbort.signal.aborted) {
          activeTurnAbort.abort();
          if (activeSpinner) activeSpinner.stop();
          process.stdout.write("\n[stopping ai response...]\n");
        }
      });

      const spinner = createSpinner("thinking...");
      activeSpinner = spinner;
      process.stdout.write("\r\x1b[2K");
      spinner.start();
      const toolDivider = `${C.dim}${"-".repeat(72)}${C.reset}\n`;
      try {
        const response = await runAiTurn(ctx.state, finalInput, {
          signal: activeTurnAbort.signal,
          workspaceContext: "Session-only mode: no global workspace context.",
          memoryContext: sessionMemoryDigest(ctx.sessionMemory),
          confirmAction: async (tool, args) => {
            if ((ctx.state.executionMode || "safe") === "yolo") return true;
            spinner.pause();
            modalPromptActive = true;
            (rl as any).__forgeModalPromptActive = true;
            const ans = (await question(rl, `${C.yellow}confirm${C.reset} ${tool} ${JSON.stringify(args)} ? [y/N]: `))
              .trim()
              .toLowerCase();
            modalPromptActive = false;
            (rl as any).__forgeModalPromptActive = false;
            if (process.stdout.isTTY) {
              process.stdout.write("\r\x1b[2K");
            }
            spinner.resume();
            return ans === "y" || ans === "yes";
          },
          onStatus: (status) => spinner.setLabel(`ai ${status}`),
          onToolCall: (tool, args) => {
            spinner.pause();
            process.stdout.write(`\n${toolDivider}`);
            process.stdout.write(`${C.cyan}• Ran${C.reset} ${formatToolCall(tool, args)}\n${C.gray}  └${C.reset}\n`);
            spinner.resume();
          },
          onToolResult: (tool, resultPreview) => {
            spinner.pause();
            process.stdout.write(`${C.gray}    > ${compactLine(resultPreview)}${C.reset}\n`);
            process.stdout.write(toolDivider);
            spinner.resume();
          },
          onPlanUpdate: (plan) => {
            currentPlan = { explanation: plan.explanation, steps: plan.steps };
            spinner.pause();
            renderPlan(currentPlan);
            spinner.resume();
          },
          onUserWait: async ({ reason, prompt, timeoutSeconds }) => {
            spinner.pause();
            const label = prompt?.trim() || "Press Enter when done, or type cancel.";
            const timeoutHint = timeoutSeconds ? ` Suggested timeout: ${timeoutSeconds}s.` : "";
            process.stdout.write(
              `${C.yellow}wait>${C.reset} ${C.white}${reason}${C.reset}${C.gray}${timeoutHint}${C.reset}\n`
            );
            modalPromptActive = true;
            (rl as any).__forgeModalPromptActive = true;
            const answer = (await question(rl, `${C.yellow}wait>${C.reset} ${label} `)).trim();
            modalPromptActive = false;
            (rl as any).__forgeModalPromptActive = false;
            if (process.stdout.isTTY) {
              process.stdout.write("\r\x1b[2K");
            }
            spinner.resume();
            if (/^(cancel|stop|abort)$/i.test(answer)) {
              return `user did not complete manual step: ${reason}`;
            }
            return `user confirmed manual step completed: ${reason}`;
          }
        });
        spinner.stop();
        process.stdout.write("\r\x1b[2K");
        if (response === "Stopped.") {
          process.stdout.write(`${C.yellow}ai stopped.${C.reset}\n`);
        } else {
          process.stdout.write(`${C.green}ai>${C.reset} ${C.white}${response}${C.reset}\n`);
          await appendTurn(ctx.chat.id, "assistant", response);
          ctx.chat.turns.push({ ts: new Date().toISOString(), role: "assistant", content: response });
          ctx.sessionMemory.push({ ts: new Date().toISOString(), role: "assistant", content: response });
          ctx.chat.updatedAt = new Date().toISOString();
          chatDirty = true;
        }
      } finally {
        spinner.stop();
        activeSpinner = null;
        compositor.exitThinking();
      }
    } catch (err) {
      console.error(`error> ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      activeTurnAbort = null;
      rl.resume();
    }
    return false;
  }

  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[2K");
  }
  rl.close();
  compositor.reset();
  stopPasteIndicator();
  clearInterval(autosaveTimer);
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
    process.stdout.write(`\r\x1b[2K${C.yellow}${f}${C.reset} ${C.dim}${label}${C.reset}`);
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

function createNoopSpinner(): {
  start: () => void;
  stop: () => void;
  setLabel: (label: string) => void;
  pause: () => void;
  resume: () => void;
} {
  return {
    start() {},
    stop() {},
    setLabel(_label: string) {},
    pause() {},
    resume() {}
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

function renderMessageBox(label: string, content: string, tone: "user" | "plain" = "plain"): void {
  const cols = Math.max(Math.min(process.stdout.columns || 96, 120), 60);
  const inner = cols - 4;
  const title = `${label}`.trim();
  const lines = wrapForBox(String(content || "").trim() || "(empty)", inner);
  const borderColor = tone === "user" ? C.gray : C.blue;
  console.log(`${borderColor}╭${"─".repeat(cols - 2)}╮${C.reset}`);
  console.log(`${borderColor}│${C.reset} ${title.padEnd(inner)} ${borderColor}│${C.reset}`);
  for (const line of lines) {
    console.log(`${borderColor}│${C.reset} ${line.padEnd(inner)} ${borderColor}│${C.reset}`);
  }
  console.log(`${borderColor}╰${"─".repeat(cols - 2)}╯${C.reset}`);
}

function wrapForBox(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\t/g, "    ");
    if (!line) {
      out.push("");
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
  }
  return out;
}

function renderPlan(plan: { explanation?: string; steps: UiPlanStep[] }): void {
  process.stdout.write(`${C.blue}plan>${C.reset}\n`);
  if (plan.explanation) process.stdout.write(`${C.gray}  ${compactLine(plan.explanation)}${C.reset}\n`);
  for (let i = 0; i < plan.steps.length; i++) {
    const item = plan.steps[i];
    const n = `${i + 1}.`;
    if (item.status === "completed") {
      process.stdout.write(`${C.gray}  ${n} [x] ${item.step}${C.reset}\n`);
      continue;
    }
    if (item.status === "in_progress") {
      process.stdout.write(`  ${n} ${C.cyan}[>]${C.reset} ${item.step}\n`);
      continue;
    }
    process.stdout.write(`  ${n} [ ] ${item.step}\n`);
  }
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
          sessionTurns: ctx.sessionMemory.length
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
      console.log(`usage: /model <model-id>`);
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
      console.log(sessionMemoryDigest(ctx.sessionMemory));
      return false;
    }
    if (sub === "clear") {
      ctx.sessionMemory = [];
      console.log("memory cleared");
      return false;
    }
    console.log("usage: /memory [show|clear]");
    return false;
  }

  if (cmd === "/mcp") {
    const sub = (args[0] || "list").trim().toLowerCase();
    if (sub === "list") {
      const servers = ctx.state.mcpServers || [];
      if (!servers.length) {
        console.log("(no mcp servers)");
        return false;
      }
      for (const server of servers) {
        console.log(`${server.name}: ${server.command} ${(server.args || []).join(" ")}`.trim());
      }
      return false;
    }
    if (sub === "tools") {
      const tools = await listMcpTools(ctx.state);
      if (!tools.length) {
        console.log("(no mcp tools discovered)");
        for (const diagnostic of getMcpDiagnostics(ctx.state)) {
          console.log(`mcp ${diagnostic.server}: ${diagnostic.message}`);
        }
        return false;
      }
      for (const tool of tools) console.log(`mcp.${tool.server}.${tool.name}${tool.description ? ` - ${tool.description}` : ""}`);
      return false;
    }
    if (sub === "add") {
      const [name, command, ...cmdArgs] = args.slice(1);
      if (!name || !command) {
        console.log("usage: /mcp add <name> <command> [args...]");
        return false;
      }
      ctx.state = {
        ...ctx.state,
        mcpServers: [...(ctx.state.mcpServers || []).filter((item) => item.name !== name), { name, command, args: cmdArgs }]
      };
      await saveState(ctx.state);
      console.log(`mcp server saved: ${name}`);
      return false;
    }
    if (sub === "remove") {
      const name = args[1];
      if (!name) {
        console.log("usage: /mcp remove <name>");
        return false;
      }
      ctx.state = { ...ctx.state, mcpServers: (ctx.state.mcpServers || []).filter((item) => item.name !== name) };
      await saveState(ctx.state);
      console.log(`mcp server removed: ${name}`);
      return false;
    }
    console.log("usage: /mcp <list|tools|add|remove> ...");
    return false;
  }

  if (cmd === "/auth") {
    const provider = (args[0] || "").trim().toLowerCase();
    if (provider !== "google") {
      console.log("usage: /auth google");
      return false;
    }
    console.log("opening Google login in your browser...");
    const google = new GoogleIntegration();
    const result = await google.connect(getGoogleUserId());
    if (!result.success) {
      console.log(`google auth failed: ${result.error}`);
      return false;
    }
    console.log(`google connected: ${result.email}`);
    return false;
  }

  if (cmd === "/logout") {
    const provider = (args[0] || "").trim().toLowerCase();
    if (provider !== "google") {
      console.log("usage: /logout google");
      return false;
    }
    const google = new GoogleIntegration();
    try {
      await google.disconnect(getGoogleUserId());
      console.log("google disconnected");
    } catch (error) {
      console.log(`google logout failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  if (trimmed === "/memory" || trimmed === "/memory ") {
    return [["show", "clear"], ""];
  }
  if (trimmed === "/mcp" || trimmed === "/mcp ") {
    return [["list", "tools", "add", "remove"], ""];
  }
  if (trimmed === "/auth" || trimmed === "/auth ") {
    return [["google"], ""];
  }
  if (trimmed === "/logout" || trimmed === "/logout ") {
    return [["google"], ""];
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
  if (tokens[0] === "/mcp" && tokens.length === 2) {
    return [["list", "tools", "add", "remove"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/auth" && tokens.length === 2) {
    return [["google"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/logout" && tokens.length === 2) {
    return [["google"].filter((v) => v.startsWith(current)), current];
  }
  if (tokens[0] === "/searchmode" && tokens.length === 2) {
    return [["safe", "manual"].filter((v) => v.startsWith(current)), current];
  }

  return [[], current];
}

function enablePasteIndicator(
  onPaste: (info: {
    phase: PasteMode;
    chars?: number;
    text?: string;
    lineCount?: number;
    multiline?: boolean;
    echoedRows?: number;
  }) => void
): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => {};

  const BRACKETED_START = "\x1b[200~";
  const BRACKETED_END = "\x1b[201~";

  let fallbackAcc = "";
  let fallbackTimer: NodeJS.Timeout | null = null;
  let bracketAcc = "";
  let streamAcc = "";
  let inBracketedPaste = false;

  const estimateEchoedRows = (text: string) => {
    const cols = Math.max(process.stdout.columns || 80, 10);
    const lines = text.split("\n");
    return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(Math.max(line.length, 1) / cols)), 0);
  };

  const emitPaste = (raw: string, fromBracketed: boolean) => {
    const normalized = raw.replace(/\r/g, "");
    const trimmed = normalized.replace(/\n+$/g, "");
    if (!trimmed) return;
    const chars = trimmed.replace(/\n/g, "").length;
    if (chars < 1) return;
    const lineCount = trimmed.split("\n").length;
    const multiline = lineCount > 1;
    if (!fromBracketed && !multiline && chars < 3) return;
    onPaste({ phase: "idle", chars, text: trimmed, lineCount, multiline, echoedRows: estimateEchoedRows(trimmed) });
  };

  const flushFallback = () => {
    if (!fallbackAcc) return;
    const next = fallbackAcc;
    fallbackAcc = "";
    emitPaste(next, false);
  };

  const onData = (buf: Buffer | string) => {
    const chunk = typeof buf === "string" ? buf : buf.toString("utf8");
    if (!chunk) return;

    streamAcc += chunk;
    while (streamAcc.length) {
      if (inBracketedPaste) {
        const endIdx = streamAcc.indexOf(BRACKETED_END);
        if (endIdx === -1) {
          bracketAcc += streamAcc;
          streamAcc = "";
          break;
        }
        bracketAcc += streamAcc.slice(0, endIdx);
        streamAcc = streamAcc.slice(endIdx + BRACKETED_END.length);
        inBracketedPaste = false;
        emitPaste(bracketAcc, true);
        bracketAcc = "";
        continue;
      }

      const startIdx = streamAcc.indexOf(BRACKETED_START);
      if (startIdx === -1) break;
      inBracketedPaste = true;
      onPaste({ phase: "receiving_paste" });
      streamAcc = streamAcc.slice(startIdx + BRACKETED_START.length);
    }

    if (inBracketedPaste) return;

    // Non-bracketed fallback: coalesce quick chunks, but only when newline or burst chunk exists.
    if (chunk.includes("\x1b")) return;
    const shouldAggregate = /[\r\n]/.test(chunk) || chunk.length > 1;
    if (!shouldAggregate) return;
    onPaste({ phase: "receiving_paste" });
    fallbackAcc += chunk;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      flushFallback();
    }, 32);
  };

  input.on("data", onData);
  return () => {
    input.off("data", onData);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    flushFallback();
  };
}

function redrawPrompt(rl: readline.Interface, prompt = "you> "): void {
  if ((rl as any).__forgeModalPromptActive) return;
  process.stdout.write(`\r\x1b[2K${prompt}${rl.line}`);
}

function clearRecentlyEchoedRows(rows: number): void {
  if (!process.stdout.isTTY || rows <= 0) return;
  for (let i = 0; i < rows; i++) {
    process.stdout.write("\r\x1b[2K");
    if (i < rows - 1) process.stdout.write("\x1b[1A");
  }
  process.stdout.write("\r\x1b[2K");
}

function insertPlaceholderToken(rl: readline.Interface, token: string, prompt: string): void {
  const current = String(rl.line || "");
  const next = current.trim().length ? `${current} ${token}` : token;
  rl.write(null, { ctrl: true, name: "u" });
  rl.write(next);
  redrawPrompt(rl, prompt);
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
  const lines = [
    `provider=${state.provider.provider} model=${state.provider.model} mode=${state.executionMode || "safe"} searchmode=${state.searchMode || "safe"}`,
    `root=${state.projectRoot}`,
    "Type /help for commands. Press Right/End for ghost autocomplete.",
    `Discord: ${C.blue}${C.underline}https://discord.gg/QrfpWDuZqd${C.reset}`,
    `Instagram: ${C.blue}${C.underline}https://www.instagram.com/cognautic/${C.reset}`
  ];
  for (const line of lines) console.log(line);
  console.log(`${C.gray}${"─".repeat(width)}${C.reset}`);
}

function printStatus(state: ForgeState, modelCount: number): void {
  console.log(JSON.stringify({
    provider: state.provider,
    executionMode: state.executionMode || "safe",
    searchMode: state.searchMode || "safe",
    browserExecutablePath: state.browserExecutablePath || null,
    projectRoot: state.projectRoot,
    modelSuggestions: modelCount
  }, null, 2));
}

async function checkForNpmUpdate(): Promise<{ name: string; current: string; latest: string } | null> {
  try {
    const meta = await readLocalPackageMeta();
    if (!meta?.name || !meta?.version) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2200);
    let res: Response;
    try {
      const url = `https://registry.npmjs.org/${encodeURIComponent(meta.name)}`;
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const payload = (await res.json()) as any;
    const latest = String(payload?.["dist-tags"]?.latest || "").trim();
    if (!latest) return null;
    if (compareSemver(latest, meta.version) <= 0) return null;
    return { name: meta.name, current: meta.version, latest };
  } catch {
    return null;
  }
}

async function readLocalPackageMeta(): Promise<PackageMeta | null> {
  try {
    const raw = await readFile(join(__dirname, "../../../package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const name = String(pkg?.name || "").trim();
    const version = String(pkg?.version || "").trim();
    if (!name || !version) return null;
    return { name, version };
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map((x) => Number(x) || 0);
  const pb = b.split("-")[0].split(".").map((x) => Number(x) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function renderUpdateBanner(current: string, latest: string, pkg: string): void {
  const line = `Update available: ${current} -> ${latest} (${pkg})`;
  const cmd = `Run: npm i -g ${pkg}@latest`;
  console.log(`${C.yellow}┌${"─".repeat(Math.max(line.length, cmd.length) + 2)}┐${C.reset}`);
  console.log(`${C.yellow}│${C.reset} ${line.padEnd(Math.max(line.length, cmd.length))} ${C.yellow}│${C.reset}`);
  console.log(`${C.yellow}│${C.reset} ${cmd.padEnd(Math.max(line.length, cmd.length))} ${C.yellow}│${C.reset}`);
  console.log(`${C.yellow}└${"─".repeat(Math.max(line.length, cmd.length) + 2)}┘${C.reset}`);
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
    "/config (interactive selectable setup)",
    "/mode <safe|yolo>",
    "/yolo [on|off|toggle] (shortcut: Ctrl+Y)",
    "/root <path>",
    "/objective <text> | /objective show",
    "/task <add|list|approve|start|review|complete|archive> ...",
    "/artifact <add|list> ...",
    "/timeline",
    "/roles [show] | /roles set <role> <owner>",
    "/memory [show|clear]",
    "/auth google",
    "/logout google",
    "/rename <chat-name>",
    "Shift+Tab toggles input mode: chat <-> shell",
    "Ctrl+V pastes clipboard image as attachment placeholder",
    "<any non-/ text> sends a chat prompt"
  ].join("\n"));
}

function getGoogleUserId(): string {
  return (
    process.env.FORGE_GOOGLE_USER_ID ||
    process.env.USER ||
    process.env.USERNAME ||
    "default"
  );
}

async function runConfigWizard(rl: readline.Interface, ctx: ChatContext): Promise<void> {
  const enquirer = await loadEnquirer();
  if (!enquirer) {
    console.log("enquirer not available, using fallback config menu.");
    await runConfigWizardFallback(rl, ctx);
    return;
  }

  console.log("Config menu (Enquirer): arrow keys to select, Enter to edit.");
  let working = { ...ctx.state };

  while (true) {
    const pick = await enqSelect(rl, enquirer, "Config", [
      { name: "provider", message: `Provider        : ${working.provider.provider}` },
      { name: "apikey", message: `API key         : ${working.provider.provider === "ollama" ? "(not required)" : "(set/update)"}` },
      { name: "model", message: `Model           : ${working.provider.model}` },
      {
        name: "endpoint",
        message: `Endpoint        : ${working.provider.endpoint || (working.provider.provider === "ollama" ? "http://127.0.0.1:11434" : "(none)")}`
      },
      { name: "browserpath", message: `Browser path    : ${working.browserExecutablePath || "(default playwright chromium)"}` },
      { name: "searchmode", message: `Search mode     : ${working.searchMode || "safe"}` },
      { name: "projectroot", message: `Project root    : ${working.projectRoot}` },
      { name: "execmode", message: `Execution mode  : ${working.executionMode || "safe"}` },
      { name: "save", message: "Save and exit" },
      { name: "cancel", message: "Cancel" }
    ]);

    if (pick === "cancel") {
      console.log("Config canceled.");
      return;
    }
    if (pick === "save") {
      working = { ...working, onboardingComplete: true };
      ctx.state = working;
      await saveState(ctx.state);
      if (ctx.state.projectRoot !== ctx.workspace.projectRoot) {
        ctx.workspace = await loadWorkspace(ctx.state.projectRoot);
      }
      await autoRefreshModels(ctx);
      console.log("Config saved.");
      return;
    }

    if (pick === "provider") {
      const providerInput = await enqSelect(rl, enquirer, "Provider", PROVIDERS.map((p) => ({ name: p, message: p })), working.provider.provider);
      if (providerInput && PROVIDERS.includes(providerInput as ProviderKind)) {
        working = setProvider(working, { ...working.provider, provider: providerInput as ProviderKind });
        try {
          const models = await fetchModels(working, working.provider.provider);
          ctx.modelSuggestions = models;
          if (models.length && !models.includes(working.provider.model)) {
            working = setProvider(working, { ...working.provider, model: models[0] });
          }
        } catch {
          // Keep current model if refresh fails.
        }
      }
      continue;
    }

    if (pick === "model") {
      if (!ctx.modelSuggestions.length) {
        try {
          ctx.modelSuggestions = await fetchModels(working, working.provider.provider);
        } catch {
          // allow manual entry
        }
      }
      const current = working.provider.model;
      let modelInput = "";
      if (ctx.modelSuggestions.length) {
        const top = ctx.modelSuggestions.slice(0, 50);
        modelInput = await enqSelect(
          rl,
          enquirer,
          "Model (Top cached)",
          [...top.map((m) => ({ name: m, message: m })), { name: "__manual__", message: "Manual model id..." }],
          current
        );
        if (modelInput === "__manual__") {
          modelInput = await enqInput(rl, enquirer, "Model id", current);
        }
      } else {
        modelInput = await enqInput(rl, enquirer, "Model id", current);
      }
      if (modelInput) {
        working = setProvider(working, { ...working.provider, model: modelInput });
      }
      continue;
    }

    if (pick === "apikey") {
      if (working.provider.provider === "ollama") {
        console.log("Ollama selected: API key not required.");
        continue;
      }
      const keyInput = await enqPassword(rl, enquirer, `API key for ${working.provider.provider}`);
      if (keyInput) working = setApiKeyInConfig(working, working.provider.provider, keyInput);
      continue;
    }

    if (pick === "endpoint") {
      const endpointInput = await enqInput(
        rl,
        enquirer,
        "Endpoint",
        working.provider.endpoint || (working.provider.provider === "ollama" ? "http://127.0.0.1:11434" : "")
      );
      if (endpointInput) working = setProvider(working, { ...working.provider, endpoint: endpointInput });
      continue;
    }

    if (pick === "browserpath") {
      const browserPathInput = await enqInput(
        rl,
        enquirer,
        "Browser executable path",
        working.browserExecutablePath || ""
      );
      if (browserPathInput) working = { ...working, browserExecutablePath: browserPathInput };
      continue;
    }

    if (pick === "searchmode") {
      const searchModeInput = await enqSelect(
        rl,
        enquirer,
        "Search mode",
        [{ name: "safe", message: "safe" }, { name: "manual", message: "manual" }],
        working.searchMode || "safe"
      );
      if (searchModeInput === "safe" || searchModeInput === "manual") working = { ...working, searchMode: searchModeInput };
      continue;
    }

    if (pick === "projectroot") {
      const rootInput = await enqInput(rl, enquirer, "Project root", working.projectRoot);
      if (rootInput) working = { ...working, projectRoot: rootInput };
      continue;
    }

    if (pick === "execmode") {
      const modeInput = await enqSelect(
        rl,
        enquirer,
        "Execution mode",
        [{ name: "safe", message: "safe" }, { name: "yolo", message: "yolo" }],
        working.executionMode || "safe"
      );
      if (modeInput === "safe" || modeInput === "yolo") working = { ...working, executionMode: modeInput };
      continue;
    }
  }
}

async function runConfigWizardFallback(rl: readline.Interface, ctx: ChatContext): Promise<void> {
  console.log("Config menu: choose field number, then edit. Enter `s` to save, `q` to cancel.");
  let working = { ...ctx.state };

  while (true) {
    console.log([
      "",
      `1) Provider        : ${working.provider.provider}`,
      `2) API key         : ${working.provider.provider === "ollama" ? "(not required)" : "(set/update)"}`,
      `3) Model           : ${working.provider.model}`,
      `4) Endpoint        : ${working.provider.endpoint || (working.provider.provider === "ollama" ? "http://127.0.0.1:11434" : "(none)")}`,
      `5) Browser path    : ${working.browserExecutablePath || "(default playwright chromium)"}`,
      `6) Search mode     : ${working.searchMode || "safe"}`,
      `7) Project root    : ${working.projectRoot}`,
      `8) Execution mode  : ${working.executionMode || "safe"}`,
      "s) Save and exit",
      "q) Cancel"
    ].join("\n"));

    const pick = (await question(rl, "config> ")).trim().toLowerCase();
    if (pick === "q") return;
    if (pick === "s") {
      working = { ...working, onboardingComplete: true };
      ctx.state = working;
      await saveState(ctx.state);
      if (ctx.state.projectRoot !== ctx.workspace.projectRoot) {
        ctx.workspace = await loadWorkspace(ctx.state.projectRoot);
      }
      await autoRefreshModels(ctx);
      console.log("Config saved.");
      return;
    }
    if (pick === "1") {
      const providerInput = (await question(rl, `Provider [${PROVIDERS.join(", ")}] (${working.provider.provider}): `)).trim();
      if (providerInput && PROVIDERS.includes(providerInput as ProviderKind)) {
        working = setProvider(working, { ...working.provider, provider: providerInput as ProviderKind });
      }
      continue;
    }
    if (pick === "2") {
      if (working.provider.provider === "ollama") continue;
      const keyInput = (await question(rl, `API key for ${working.provider.provider}: `)).trim();
      if (keyInput) working = setApiKeyInConfig(working, working.provider.provider, keyInput);
      continue;
    }
    if (pick === "3") {
      const modelInput = (await question(rl, `Model (${working.provider.model}): `)).trim();
      if (modelInput) working = setProvider(working, { ...working.provider, model: modelInput });
      continue;
    }
    if (pick === "4") {
      const endpointInput = (await question(rl, "Endpoint: ")).trim();
      if (endpointInput) working = setProvider(working, { ...working.provider, endpoint: endpointInput });
      continue;
    }
    if (pick === "5") {
      const browserPathInput = (await question(rl, "Browser executable path: ")).trim();
      if (browserPathInput) working = { ...working, browserExecutablePath: browserPathInput };
      continue;
    }
    if (pick === "6") {
      const searchModeInput = (await question(rl, "Search mode [safe/manual]: ")).trim().toLowerCase();
      if (searchModeInput === "safe" || searchModeInput === "manual") working = { ...working, searchMode: searchModeInput };
      continue;
    }
    if (pick === "7") {
      const rootInput = (await question(rl, `Project root (${working.projectRoot}): `)).trim();
      if (rootInput) working = { ...working, projectRoot: rootInput };
      continue;
    }
    if (pick === "8") {
      const modeInput = (await question(rl, "Execution mode [safe/yolo]: ")).trim().toLowerCase();
      if (modeInput === "safe" || modeInput === "yolo") working = { ...working, executionMode: modeInput };
    }
  }
}

type EnquirerModule = {
  prompt: (question: Record<string, unknown>) => Promise<Record<string, string>>;
};

async function loadEnquirer(): Promise<EnquirerModule | null> {
  try {
    const mod = await import("enquirer");
    const anyMod = mod as any;
    const promptFn =
      (typeof anyMod?.prompt === "function" && anyMod.prompt) ||
      (typeof anyMod?.default?.prompt === "function" && anyMod.default.prompt) ||
      (typeof anyMod?.default === "function" && typeof anyMod.default.prompt === "function" && anyMod.default.prompt) ||
      null;
    if (!promptFn) return null;
    return { prompt: promptFn as EnquirerModule["prompt"] };
  } catch {
    return null;
  }
}

async function enqSelect(
  rl: readline.Interface,
  enquirer: EnquirerModule,
  message: string,
  choices: Array<{ name: string; message: string }>,
  initial?: string
): Promise<string> {
  const initialIndex = typeof initial === "string" ? Math.max(0, choices.findIndex((c) => c.name === initial)) : 0;
  const out = await withRlPaused(rl, async () => {
    const ans = await enquirer.prompt({
      type: "select",
      name: "value",
      message,
      choices,
      initial: initialIndex
    });
    return String(ans.value || "");
  });
  return out;
}

async function enqInput(rl: readline.Interface, enquirer: EnquirerModule, message: string, initial = ""): Promise<string> {
  return await withRlPaused(rl, async () => {
    const ans = await enquirer.prompt({
      type: "input",
      name: "value",
      message,
      initial
    });
    return String(ans.value || "").trim();
  });
}

async function enqPassword(rl: readline.Interface, enquirer: EnquirerModule, message: string): Promise<string> {
  return await withRlPaused(rl, async () => {
    const ans = await enquirer.prompt({
      type: "password",
      name: "value",
      message
    });
    return String(ans.value || "").trim();
  });
}

async function withRlPaused<T>(rl: readline.Interface, fn: () => Promise<T>): Promise<T> {
  rl.pause();
  try {
    return await fn();
  } finally {
    rl.resume();
  }
}

function sessionMemoryDigest(turns: ChatTurn[]): string {
  const recent = turns.slice(-24);
  const pairs: string[] = [];
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    if (t.role !== "user") continue;
    const a = recent.slice(i + 1).find((x) => x.role === "assistant");
    pairs.push(`- ${trimForDigest(t.content)} => ${trimForDigest(a?.content || "(pending)")}`);
  }
  return [
    "Session memory (current chat only):",
    ...(pairs.length ? pairs.slice(-8) : ["(empty)"])
  ].join("\n");
}

function trimForDigest(s: string): string {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  if (!one) return "(empty)";
  return one.length > 120 ? `${one.slice(0, 120)}...` : one;
}

async function pasteImageFromClipboard(projectRoot: string): Promise<{ path: string; mime: string; bytes: number } | null> {
  const image = await readClipboardImage();
  if (!image || !image.bytes.length) return null;
  const ext = image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png";
  const dir = join(projectRoot, ".forge-data", "pastes");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `clipboard-${Date.now()}.${ext}`);
  await writeFile(path, image.bytes);
  return { path, mime: image.mime, bytes: image.bytes.length };
}

async function readClipboardImage(): Promise<{ bytes: Buffer; mime: string } | null> {
  const linuxWayland = await readClipboardVia("wl-paste", ["--list-types"], null, async (types) => {
    const mime = pickImageMime(types);
    if (!mime) return null;
    const bytes = await runCmdCollectStdout("wl-paste", ["--no-newline", "--type", mime], null);
    return bytes.length ? { bytes, mime } : null;
  });
  if (linuxWayland) return linuxWayland;

  const linuxX11Png = await runCmdCollectStdout("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], null);
  if (linuxX11Png.length) return { bytes: linuxX11Png, mime: "image/png" };
  const linuxX11Jpg = await runCmdCollectStdout("xclip", ["-selection", "clipboard", "-t", "image/jpeg", "-o"], null);
  if (linuxX11Jpg.length) return { bytes: linuxX11Jpg, mime: "image/jpeg" };

  const macPng = await runCmdCollectStdout("pngpaste", ["-"], null);
  if (macPng.length) return { bytes: macPng, mime: "image/png" };
  return null;
}

async function readClipboardVia<T>(
  command: string,
  args: string[],
  stdin: string | null,
  mapper: (stdoutText: string) => Promise<T | null>
): Promise<T | null> {
  const out = await runCmdCollectStdout(command, args, stdin);
  if (!out.length) return null;
  return await mapper(out.toString("utf8"));
}

function pickImageMime(types: string): string | null {
  const lines = types
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
    if (lines.includes(mime)) return mime;
  }
  return null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCmdCollectStdout(command: string, args: string[], stdinText: string | null): Promise<Buffer> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };

    child.on("error", () => finish(Buffer.alloc(0)));
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code) => {
      if (code !== 0) return finish(Buffer.alloc(0));
      finish(Buffer.concat(chunks));
    });
    if (stdinText !== null && child.stdin) child.stdin.write(stdinText);
    if (child.stdin) child.stdin.end();
  });
}
