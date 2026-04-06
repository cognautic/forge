import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { CoworkRole, ForgeState, ProviderKind, TaskStatus } from "../types";
import { saveState } from "../core/state";
import { PROVIDERS, fetchModels, setApiKeyInConfig, setProvider } from "../providers/manager";
import { runAiTurn } from "../agent/chatAgent";
import { runCommand } from "../terminal/exec";
import { getEffectiveMcpServers, getMcpDiagnostics, listMcpTools, prewarmMcpServers } from "../mcp/client";
import { GoogleIntegration } from "../../integrations/google";
import {
  installSkillFromFile,
  listInstalledSkills,
  loadSkillsContext,
  resolveSkillSourcePath
} from "../core/skills";
import {
  addArtifact,
  addTask,
  loadWorkspace,
  saveWorkspace,
  setObjective,
  setRoleOwner,
  setTaskStatus,
  workspaceDigest,
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

let uiRenderInProgress = false;

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
type ConfigFieldKey =
  | "provider"
  | "apikey"
  | "model"
  | "endpoint"
  | "browserpath"
  | "searchmode"
  | "projectroot"
  | "execmode";
type ConfigActionKey = ConfigFieldKey | "save" | "cancel";
type ConfigScreenState = {
  working: ForgeState;
  selectedIndex: number;
  mode: "nav" | "edit";
  editingField?: ConfigFieldKey;
  editBuffer: string;
  resolver: () => void;
  notice: string;
};

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
  "/skill",
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

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "/help": "show available commands",
  "/exit": "exit Forge",
  "/status": "show current status",
  "/providers": "list providers",
  "/provider": "set provider",
  "/models": "list/refresh models",
  "/model": "set model",
  "/apikey": "set provider API key",
  "/mode": "set execution mode",
  "/yolo": "toggle YOLO mode",
  "/root": "set project root",
  "/endpoint": "set custom endpoint",
  "/browserpath": "set browser executable path",
  "/searchmode": "set search mode",
  "/config": "interactive setup",
  "/skill": "add/list skills",
  "/objective": "set/show objective",
  "/task": "manage tasks",
  "/artifact": "manage artifacts",
  "/timeline": "show timeline",
  "/roles": "show/set roles",
  "/memory": "show/clear memory",
  "/mcp": "manage MCP servers/tools",
  "/auth": "authenticate integrations",
  "/logout": "logout integrations",
  "/rename": "rename current chat",
  "/clear": "clear the screen"
};

const FORGE_LOGO_SOURCE = [
  "    ██████████████████████████████    ",
  "    ██████████████████████████████    ",
  "    ██████████████████████████████    ",
  "██████████                  ██████    ",
  "██████████ ██████    ██████ ██████████",
  "██████████ ██████    ██████ ██████████",
  "██████████ ██████    ██████ ██████████",
  "██████████                  ██████████",
  "██████████                  ██████████",
  "    ██████████████████████████████    ",
  "    ██████████████████████████████    ",
  "    ██████████████████████████████    ",
  "           ██████    ██████           ",
  "           ██████    ██████           "
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
  const promptMode = () => (shellMode ? "shell" : "chat");

  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const rawConsoleLog = console.log.bind(console);
  const rawConsoleError = console.error.bind(console);
  let rl!: readline.Interface;

  const outputLines: string[] = [];
  const OUTPUT_MAX_LINES = 5000;
  let outputCarry = "";
  let renderScheduled = false;
  let fullscreenActive = false;
  let scrollOffset = 0; // 0 = bottom (latest)
  let aiThinking = false;
  let thinkingTimer: NodeJS.Timeout | null = null;
  let thinkingFrame = 0;
  const THINK_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let suggestionSelected = 0;
  const rlInput = new PassThrough();
  let mouseCarry: Buffer | null = null;

  const scheduleRender = () => {
    if (!process.stdout.isTTY) return;
    if (!fullscreenActive) return;
    if (renderScheduled) return;
    renderScheduled = true;
    setImmediate(() => {
      renderScheduled = false;
      renderScreen();
    });
  };

  const setThinking = (on: boolean) => {
    aiThinking = on;
    if (!process.stdout.isTTY) return;
    if (!fullscreenActive) return;
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    if (on) {
      thinkingTimer = setInterval(() => {
        thinkingFrame = (thinkingFrame + 1) % THINK_FRAMES.length;
        scheduleRender();
      }, 80);
      // Don't keep the process alive just for the animation timer.
      (thinkingTimer as any).unref?.();
    } else {
      thinkingFrame = 0;
      scheduleRender();
    }
  };

  const appendOutput = (text: string) => {
    if (!text) return;
    const combined = outputCarry + text;
    const parts = combined.split(/\r?\n/);
    outputCarry = parts.pop() ?? "";
    for (const line of parts) outputLines.push(line);
    while (outputLines.length > OUTPUT_MAX_LINES) outputLines.shift();
    // If user is not at tail, keep their view anchored as new lines arrive.
    if (scrollOffset > 0) scrollOffset = Math.min(scrollOffset + parts.length, OUTPUT_MAX_LINES);
    scheduleRender();
  };

  const resetChatInputState = () => {
    mouseCarry = null;
    pendingGhostSuffix = "";
    suggestionSelected = 0;
    (rl as any).__forgeExternalPromptActive = false;
    (rl as any).line = "";
    (rl as any).cursor = 0;
    try {
      rl.resume();
    } catch {
      // ignore
    }
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        // ignore terminal restoration failures
      }
      if (process.stdin.isPaused()) process.stdin.resume();
    }
  };

  const runConfigSession = async () => {
    configWizardActive = true;
    try {
      await new Promise<void>((resolve) => {
        configScreen = {
          working: { ...ctx.state, provider: { ...ctx.state.provider }, apiKeys: { ...ctx.state.apiKeys } },
          selectedIndex: 0,
          mode: "nav",
          editBuffer: "",
          resolver: resolve,
          notice: "Arrows move. Enter edits/selects. Esc cancels."
        };
        scheduleRender();
      });
    } finally {
      configWizardActive = false;
      configScreen = null;
      resetChatInputState();
      scheduleRender();
    }
  };

  const enterFullscreen = () => {
    if (!process.stdout.isTTY || fullscreenActive) return;
    fullscreenActive = true;
    // Alternate screen + clear + hide cursor + disable wrap + enable mouse wheel reporting.
    // Mouse: 1000 (normal tracking) + 1006 (SGR extended). Many terminals emit wheel as SGR.
    rawStdoutWrite("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h");
  };

  const exitFullscreen = () => {
    if (!process.stdout.isTTY || !fullscreenActive) return;
    fullscreenActive = false;
    // Enable wrap + show cursor + leave alternate screen.
    rawStdoutWrite("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l");
  };

  const rlOutput = new (class extends Writable {
    public muted = true;
    _write(chunk: any, _enc: BufferEncoding, cb: (error?: Error | null) => void) {
      if (!this.muted) rawStdoutWrite(chunk);
      cb();
    }
  })();

  rl = readline.createInterface({
    input: rlInput,
    output: rlOutput,
    terminal: Boolean(process.stdout.isTTY),
    historySize: 300,
    completer: (line: string) => completeLine(line, ctx)
  });
  // Fullscreen compositor output routing.
  (process.stdout as any).write = ((chunk: any, encoding?: any, cb?: any) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString(encoding || "utf8") : String(chunk);
    if ((rl as any)?.__forgeExternalPromptActive) {
      rawStdoutWrite(chunk, encoding, cb);
      return true;
    }
    appendOutput(text);
    if (typeof cb === "function") cb();
    return true;
  }) as any;
  console.log = (...args: any[]) => {
    if ((rl as any)?.__forgeExternalPromptActive) {
      rawConsoleLog(...args);
      return;
    }
    appendOutput(args.join(" ") + "\n");
  };
  console.error = (...args: any[]) => {
    if ((rl as any)?.__forgeExternalPromptActive) {
      rawConsoleError(...args);
      return;
    }
    appendOutput(args.join(" ") + "\n");
  };
  compositor.setReadline(rl);
  
  const pasteState: { mode: PasteMode } = { mode: "idle" };
  let suppressQueuedPasteLines = 0;
  let pendingTextPasteToken: string | null = null;
  let pendingAttachments: PendingAttachment[] = [];
  let pendingImagePastes: Array<{ path: string; mime: string; bytes: number }> = [];
  let imagePasteBusy = false;
  let modalPromptActive = false;
  let configWizardActive = false;
  let configScreen: ConfigScreenState | null = null;
  let launchingInlineConfig = false;
  let lastSubmittedInput = "";
  let lastSubmittedAt = 0;
  let currentPlan: { explanation?: string; steps: UiPlanStep[] } | null = null;
  let pendingPromptRedraw: NodeJS.Immediate | null = null;
  let pendingGhostSuffix = "";
  let modalPromptLabel = "";
  let modalPromptBuffer = "";
  let preservedInputLine = "";
  let preservedInputCursor = 0;

  const schedulePromptRedraw = (ghost = "") => {
    pendingGhostSuffix = ghost;
    if (pendingPromptRedraw) return;
    pendingPromptRedraw = setImmediate(() => {
      pendingPromptRedraw = null;
      if (!modalPromptActive) scheduleRender();
    });
  };

  const renderScreen = () => {
    if (!process.stdout.isTTY) return;
    if (!fullscreenActive) return;
    if (uiRenderInProgress) return;

    uiRenderInProgress = true;
    try {
      const cols = process.stdout.columns || 96;
      const rows = (process.stdout as any).rows || 32;

      if (configScreen) {
        const lines = buildConfigPanel(cols, rows, configScreen);
        rawStdoutWrite("\x1b[?25l\x1b[H\x1b[2J");
        for (const line of lines) {
          rawStdoutWrite(padAnsi(truncateAnsi(line, Math.max(0, cols - 1)), Math.max(0, cols - 1)) + "\n");
        }
        return;
      }

      const input = configWizardActive
        ? { lines: [] }
        : buildInputPanel({
            cols,
            mode: modalPromptActive && fullscreenActive ? "modal" : promptMode(),
            line: modalPromptActive && fullscreenActive ? modalPromptBuffer : String(rl.line || ""),
            cursor: modalPromptActive && fullscreenActive
              ? modalPromptBuffer.length
              : Math.max(0, Math.min((rl as any).cursor ?? (rl.line || "").length, (rl.line || "").length)),
            ctx,
            ghostSuffix: pendingGhostSuffix,
            thinking: aiThinking ? THINK_FRAMES[thinkingFrame] : "",
            selectedIndex: suggestionSelected,
            modalLabel: modalPromptActive && fullscreenActive ? modalPromptLabel : "",
          });
      const inputH = input.lines.length;

      const availableOutputH = Math.max(0, rows - inputH);
      const tail: string[] = [];
      const carry = outputCarry ? [outputCarry] : [];
      const all = outputLines.concat(carry);
      const outputWidth = Math.max(1, cols - 1);
      const visualLines = all.flatMap((line) => wrapAnsiLine(line, outputWidth));
      const maxScroll = Math.max(0, visualLines.length - availableOutputH);
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
      const start = Math.max(0, visualLines.length - availableOutputH - scrollOffset);
      for (const l of visualLines.slice(start, start + availableOutputH)) {
        tail.push(padAnsi(truncateAnsi(l, outputWidth), outputWidth));
      }
      while (tail.length < availableOutputH) tail.unshift("");

      rawStdoutWrite("\x1b[?25l\x1b[H\x1b[2J");
      for (const l of tail) rawStdoutWrite(l + "\n");
      for (const l of input.lines) rawStdoutWrite(padAnsi(truncateAnsi(l, Math.max(0, cols - 1)), Math.max(0, cols - 1)) + "\n");
      // Terminal cursor stays hidden; we render a visible cursor in the input line.
    } finally {
      uiRenderInProgress = false;
    }
  };

  const onMasterKeypress = async (str: string, key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string }) => {
    if (configScreen) {
      if (await handleConfigKeypress(str, key, configScreen, ctx)) {
        scheduleRender();
        return;
      }
    }

    // While AI is responding, readline is paused. Keep input editable in fullscreen
    // by applying keypresses directly to `rl.line` so typed text doesn't end up elsewhere.
    if (fullscreenActive && aiThinking && !modalPromptActive) {
      const current = String((rl as any).line || "");
      const cur = Math.max(0, Math.min((rl as any).cursor ?? current.length, current.length));

      if (key?.name === "left") {
        (rl as any).cursor = Math.max(0, cur - 1);
        scheduleRender();
        return;
      }
      if (key?.name === "right") {
        (rl as any).cursor = Math.min(current.length, cur + 1);
        scheduleRender();
        return;
      }
      if (key?.name === "backspace") {
        if (cur > 0) {
          (rl as any).line = current.slice(0, cur - 1) + current.slice(cur);
          (rl as any).cursor = cur - 1;
        }
        scheduleRender();
        return;
      }
      if (key?.ctrl && key?.name === "u") {
        (rl as any).line = "";
        (rl as any).cursor = 0;
        scheduleRender();
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        // Ignore submits while thinking; Esc/Ctrl+C stops the turn.
        return;
      }
      if (typeof str === "string" && str.length === 1 && !key?.ctrl) {
        (rl as any).line = current.slice(0, cur) + str + current.slice(cur);
        (rl as any).cursor = cur + 1;
        scheduleRender();
        return;
      }
      // Fall through for other keys (Esc/Ctrl+C handled by compositor).
    }

    // Scroll output pane (PageUp/PageDown) in fullscreen mode.
    if (!modalPromptActive && fullscreenActive && (key?.name === "pageup" || key?.name === "pagedown")) {
      const cols = process.stdout.columns || 96;
      const rows = (process.stdout as any).rows || 32;
      const inputH = configWizardActive
        ? 0
        : buildInputPanel({
            cols,
            mode: promptMode(),
            line: String(rl.line || ""),
            cursor: Math.max(0, Math.min((rl as any).cursor ?? (rl.line || "").length, (rl.line || "").length)),
            ctx,
            ghostSuffix: pendingGhostSuffix,
            thinking: aiThinking ? THINK_FRAMES[thinkingFrame] : "",
            selectedIndex: suggestionSelected,
          }).lines.length;
      const page = Math.max(1, rows - inputH - 1);
      if (key.name === "pageup") {
        scrollOffset = Math.min(outputLines.length, scrollOffset + page);
      } else {
        scrollOffset = Math.max(0, scrollOffset - page);
      }
      scheduleRender();
      return;
    }

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
            insertPlaceholderToken(rl, token, promptMode());
            if (!modalPromptActive) scheduleRender();
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
      if (!modalPromptActive) scheduleRender();
      return;
    }

    // 3. Mode Toggle (Shift+Tab)
    if (key?.name === "tab" && key?.shift) {
      shellMode = !shellMode;
      process.stdout.write(`\ninput-mode=${shellMode ? "shell" : "chat"} (toggled via Shift+Tab)\n`);
      if (!modalPromptActive) scheduleRender();
      return;
    }

    // 4. PageUp -> Up (non-fullscreen only)
    if (!fullscreenActive && key?.name === "pageup") {
      rl.write(null, { name: "up" });
      return;
    }

    // 5. Esc/Ctrl+C Abort logic is now handled globally by the compositor in thinking mode.
    // Here we just handle redraws and ghost redraws.

  // 6. Ghost Suggestions & Autocomplete
  if (!modalPromptActive && key?.name !== "return" && key?.name !== "enter") {
      // No inline/ghost suggestions; the selectable panel below the input handles suggestions.
      schedulePromptRedraw("");
    }
  };

  compositor.on("keypress", onMasterKeypress);
  compositor.on("data", (chunk: Buffer) => {
    if (configScreen) {
      return;
    }
    const chunkText = chunk.toString("utf8");
    if (!modalPromptActive && !launchingInlineConfig && (chunkText === "\r" || chunkText === "\n" || chunkText === "\r\n")) {
      const currentLine = String((rl as any).line || "").trim();
      if (currentLine === "/config") {
        launchingInlineConfig = true;
        (rl as any).line = "";
        (rl as any).cursor = 0;
        void (async () => {
          try {
            await runConfigSession();
          } finally {
            launchingInlineConfig = false;
            scheduleRender();
          }
        })();
        scheduleRender();
        return;
      }
    }
    if ((rl as any).__forgeExternalPromptActive) {
      return;
    }
    if (modalPromptActive) {
      if (fullscreenActive) {
        const text = chunk.toString("utf8");
        if (text === "\r" || text === "\n" || text === "\r\n") {
          scheduleRender();
        } else if (text === "\u007f") {
          modalPromptBuffer = modalPromptBuffer.slice(0, -1);
          scheduleRender();
        } else if (/^[\x20-\x7e]$/.test(text)) {
          modalPromptBuffer += text;
          scheduleRender();
        }
      }
      rlInput.write(chunk);
      return;
    }

    // During AI turns, the fullscreen UI applies edits directly to `rl.line`.
    // Forwarding the same raw bytes into readline leaves queued input behind,
    // especially after Escape/Ctrl+C aborts, which can wedge the next prompt.
    if (aiThinking) {
      return;
    }

    // Forward non-mouse bytes to readline via a filtered stream.
    // Strip both:
    // - xterm SGR mouse: ESC [ < b ; x ; y M|m
    // - legacy X10 mouse: ESC [ M b x y  (3 bytes)
    const buf = mouseCarry ? Buffer.concat([mouseCarry, chunk]) : chunk;
    const out: number[] = [];
    let i = 0;

    const emitWheel = (b: number) => {
      if (!fullscreenActive) return;
      if (b !== 64 && b !== 65) return;
      const delta = 3;
      if (b === 64) scrollOffset = Math.min(outputLines.length, scrollOffset + delta);
      if (b === 65) scrollOffset = Math.max(0, scrollOffset - delta);
      scheduleRender();
    };

    while (i < buf.length) {
      const ch = buf[i];
      if (ch === 0x1b && i + 1 < buf.length && buf[i + 1] === 0x5b) {
        if (i + 2 >= buf.length) break; // incomplete CSI
        // SGR mouse: ESC[<b;x;yM or ESC[<b;x;ym
        if (buf[i + 2] === 0x3c) {
          let j = i + 3;
          while (j < buf.length && buf[j] !== 0x4d && buf[j] !== 0x6d) j++; // 'M' or 'm'
          if (j >= buf.length) break; // incomplete

          // Parse b (first number) for wheel detection.
          let k = i + 3;
          let bStr = "";
          while (k < j && buf[k] >= 0x30 && buf[k] <= 0x39) {
            bStr += String.fromCharCode(buf[k]);
            k++;
          }
          if (bStr) emitWheel(Number(bStr));

          i = j + 1; // skip entire sequence
          continue;
        }
        // X10 mouse: ESC[M + 3 bytes
        if (buf[i + 2] === 0x4d) {
          if (i + 5 >= buf.length) break; // incomplete
          i += 6;
          continue;
        }
        // Non-mouse CSI belongs to normal keyboard input (arrows, history,
        // home/end, delete, etc.) and must still reach readline.
        out.push(ch);
        i++;
        continue;
      }

      // Non-mouse byte: forward.
      out.push(ch);
      i++;
    }

    mouseCarry = i < buf.length ? buf.subarray(i) : null;
    if (out.length) {
      rlInput.write(Buffer.from(out));
      scheduleRender();
    }
  });

  compositor.on("keypress", (_str: string, key: any) => {
    if (!fullscreenActive || modalPromptActive || configScreen || (rl as any).__forgeExternalPromptActive) return;
    const line = String(rl.line || "");
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("/")) return;
    const [items] = completeLine(trimmed, ctx);
    if (items.length) {
      suggestionSelected = Math.max(0, Math.min(suggestionSelected, items.length - 1));
    } else {
      suggestionSelected = 0;
    }
    if (key?.name === "up") {
      suggestionSelected = Math.max(0, suggestionSelected - 1);
      scheduleRender();
      return;
    }
    if (key?.name === "down") {
      suggestionSelected = Math.min(suggestionSelected + 1, Math.max(0, items.length - 1));
      scheduleRender();
      return;
    }
    if (key?.name === "tab" || key?.name === "right") {
      if (!items.length) return;
      const pickRaw = items[Math.max(0, Math.min(suggestionSelected, items.length - 1))];
      const pick = String(pickRaw || "");
      // Replace current input with selected completion (preserve leading spaces if any).
      const leading = line.slice(0, line.length - trimmed.length);
      if (/\s/.test(trimmed)) {
        // Completing an argument (e.g. "/provider <name>"): replace the last token.
        const nextTrimmed = trimmed.replace(/\S*$/, pick);
        (rl as any).line = `${leading}${nextTrimmed}`;
      } else {
        // Completing a command: ensure a single leading slash.
        const name = pick.startsWith("/") ? pick.slice(1) : pick;
        (rl as any).line = `${leading}/${name}`;
      }
      (rl as any).cursor = ((rl as any).line as string).length;
      scheduleRender();
      return;
    }
  });

  const stopPasteIndicator = enablePasteIndicator(({ phase, chars, text, multiline, echoedRows, lineCount }) => {
    if (phase === "receiving_paste") {
      if (pasteState.mode === "idle") pasteState.mode = "receiving_paste";
      return;
    }
    if (typeof chars !== "number" || typeof text !== "string") {
      if (pasteState.mode === "receiving_paste") pasteState.mode = "idle";
      return;
    }

    // Allow normal paste behavior; don't inject placeholder tokens.
    pasteState.mode = "idle";
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
  const logoAscii = FORGE_LOGO_SOURCE;
  enterFullscreen();
  // Render the banner into scrollback so output naturally "pushes" it away.
  for (const l of buildHeaderPanel(ctx.state, process.stdout.columns || 96, logoAscii)) outputLines.push(stripAnsi(l));
  outputLines.push("");
  scheduleRender();
  const onResize = () => scheduleRender();
  process.on("SIGWINCH", onResize);
  if (updateInfo) renderUpdateBanner(updateInfo.current, updateInfo.latest, updateInfo.name);
  const effectiveMcpServers = getEffectiveMcpServers(ctx.state);
  if (effectiveMcpServers.length) {
    console.log(`${C.gray}mcp> loading ${effectiveMcpServers.length} servers in background...${C.reset}`);
    void prewarmMcpServers(ctx.state, ({ completed, total, server, tools, ok, message }) => {
      const status = ok ? `${tools} tools` : `failed`;
      process.stdout.write(`${C.gray}mcp> ${completed}/${total} ${server} ${status}${C.reset}\n`);
    }).then((tools) => {
      const serverCount = effectiveMcpServers.length;
      process.stdout.write(`${C.gray}mcp ready: ${serverCount} servers, ${tools.length} tools${C.reset}\n`);
      for (const diagnostic of getMcpDiagnostics(ctx.state)) {
        if (!diagnostic.ok || diagnostic.tools === 0) {
          process.stdout.write(`${C.gray}mcp! ${diagnostic.server}: ${diagnostic.message}${C.reset}\n`);
        }
      }
    }).catch(() => {
      process.stdout.write(`${C.gray}mcp warmup skipped${C.reset}\n`);
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
    await runConfigSession();
  } else {
    await autoRefreshModels(ctx);
  }

  while (true) {
    if (suppressQueuedPasteLines > 0) {
      await question(rl, "", { mute: true });
      suppressQueuedPasteLines--;
      if (suppressQueuedPasteLines === 0) {
        if (pendingTextPasteToken) {
          insertPlaceholderToken(rl, pendingTextPasteToken, promptMode());
          pendingTextPasteToken = null;
        }
      }
      scheduleRender();
      continue;
    }

    scheduleRender();
    const source = await question(rl, "", { mute: true });
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
      if (process.stdout.isTTY && !fullscreenActive) {
        process.stdout.write("\r\x1b[2K");
      }
      rl.pause();
      break;
    }
  }

  async function processInput(input: string): Promise<boolean> {
    if (input.startsWith("/")) {
      try {
        const shouldExit = await handleSlash(input, ctx, rl, { openConfig: runConfigSession });
        return shouldExit;
      } finally {
        scheduleRender();
      }
    }

    if (shellMode) {
      try {
        const r = await runCommand(input, ctx.state.projectRoot);
        if (r.output?.trim()) process.stdout.write(`${r.output.trimEnd()}\n`);
        process.stdout.write(`exit=${r.code}\n`);
      } catch (err) {
        console.error(`error> ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        scheduleRender();
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
      if (process.stdout.isTTY && !fullscreenActive) {
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
          if (modalPromptActive) {
            try {
              rlInput.write("\n");
            } catch {
              // ignore prompt-cancel write failures
            }
          }
          if (activeSpinner) activeSpinner.stop();
          process.stdout.write("\n[stopping ai response...]\n");
          if (fullscreenActive) setThinking(false);
        }
      });
      if (fullscreenActive) setThinking(true);

      const spinner = createSpinner("thinking...");
      activeSpinner = spinner;
      if (!fullscreenActive) {
        process.stdout.write("\r\x1b[2K");
        spinner.start();
      }
      const toolDivider = `${C.dim}${"-".repeat(72)}${C.reset}\n`;
      try {
        const skillsContext = await loadSkillsContext(ctx.state.projectRoot);
        const globalSkillFiles = (await listInstalledSkills(ctx.state.projectRoot)).global.map((s) => s.path);
        const response = await runAiTurn(ctx.state, finalInput, {
          signal: activeTurnAbort.signal,
          skillsContext,
          skillsFiles: {
            globalAbsolute: globalSkillFiles
          },
          workspaceContext: workspaceDigest(ctx.workspace),
          memoryContext: sessionMemoryDigest(ctx.sessionMemory),
          confirmAction: async (tool, args) => {
            if ((ctx.state.executionMode || "safe") === "yolo") return true;
            if (!activeTurnAbort || activeTurnAbort.signal.aborted) return false;
            spinner.pause();
            modalPromptActive = true;
            (rl as any).__forgeModalPromptActive = true;
            preservedInputLine = String((rl as any).line || "");
            preservedInputCursor = Math.max(0, Number((rl as any).cursor ?? preservedInputLine.length));
            modalPromptLabel = "confirm";
            modalPromptBuffer = "";
            try {
              const promptText = `${C.yellow}confirm${C.reset} ${tool} ${JSON.stringify(args)} ? [y/N]: `;
              if (fullscreenActive) {
                process.stdout.write(`${promptText}\n`);
              }
              const ans = (await question(rl, fullscreenActive ? "" : promptText, fullscreenActive ? { mute: true } : undefined))
                .trim()
                .toLowerCase();
              if (!activeTurnAbort || activeTurnAbort.signal.aborted) return false;
              return ans === "y" || ans === "yes";
            } finally {
              modalPromptActive = false;
              (rl as any).__forgeModalPromptActive = false;
               modalPromptLabel = "";
               modalPromptBuffer = "";
               (rl as any).line = preservedInputLine;
               (rl as any).cursor = preservedInputCursor;
              if (process.stdout.isTTY && !fullscreenActive) {
                process.stdout.write("\r\x1b[2K");
              }
              spinner.resume();
            }
          },
          onStatus: (status) => spinner.setLabel(`ai ${status}`),
          onToolCall: (tool, args) => {
            spinner.pause();
            if (tool === "files.read") {
              const path = String((args as any)?.path || "").trim();
              if (path && globalSkillFiles.includes(path)) {
                spinner.setLabel(`reading ${path} skill file`);
              }
            }
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
            preservedInputLine = String((rl as any).line || "");
            preservedInputCursor = Math.max(0, Number((rl as any).cursor ?? preservedInputLine.length));
            modalPromptLabel = "wait";
            modalPromptBuffer = "";
            try {
              const waitPrompt = `${C.yellow}wait>${C.reset} ${label} `;
              if (fullscreenActive) {
                process.stdout.write(`${waitPrompt}\n`);
              }
              const answer = (await question(rl, fullscreenActive ? "" : waitPrompt, fullscreenActive ? { mute: true } : undefined)).trim();
              if (/^(cancel|stop|abort)$/i.test(answer)) {
                return `user did not complete manual step: ${reason}`;
              }
              return `user confirmed manual step completed: ${reason}`;
            } finally {
              modalPromptActive = false;
              (rl as any).__forgeModalPromptActive = false;
              modalPromptLabel = "";
              modalPromptBuffer = "";
              (rl as any).line = preservedInputLine;
              (rl as any).cursor = preservedInputCursor;
              if (process.stdout.isTTY && !fullscreenActive) {
                process.stdout.write("\r\x1b[2K");
              }
              spinner.resume();
            }
          }
        });
        spinner.stop();
        if (!fullscreenActive) process.stdout.write("\r\x1b[2K");
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
        if (fullscreenActive) setThinking(false);
        compositor.exitThinking();
      }
    } catch (err) {
      console.error(`error> ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      activeTurnAbort = null;
      modalPromptActive = false;
      (rl as any).__forgeModalPromptActive = false;
      resetChatInputState();
      if (fullscreenActive) {
        renderScreen();
      }
      scheduleRender();
    }
    return false;
  }

  if (process.stdout.isTTY) {
    // Final render cleanup.
    exitFullscreen();
  }
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  rl.close();
  rlInput.end();
  process.off("SIGWINCH", onResize);
  // Restore global writers.
  (process.stdout as any).write = rawStdoutWrite as any;
  console.log = rawConsoleLog;
  console.error = rawConsoleError;
  compositor.reset();
  stopPasteIndicator();
  clearInterval(autosaveTimer);
  // Ensure terminal returns to a sane state even if something went sideways.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
    try {
      process.stdin.pause();
    } catch {
      // ignore
    }
  }
  console.log(`to resume this chat use: forge resume ${ctx.chat.name}`);
}

function question(rl: readline.Interface, prompt: string, opts?: { mute?: boolean }): Promise<string> {
  const output = (rl as any).output as { muted?: boolean } | undefined;
  const prevMuted = output?.muted;
  if (output && typeof output.muted === "boolean") {
    output.muted = Boolean(opts?.mute);
  }
  return new Promise((resolve) => rl.question(prompt, (ans) => {
    if (output && typeof output.muted === "boolean" && typeof prevMuted === "boolean") {
      output.muted = prevMuted;
    }
    resolve(ans);
  }));
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

async function handleSlash(
  input: string,
  ctx: ChatContext,
  rl: readline.Interface,
  actions?: { openConfig?: () => Promise<void> }
): Promise<boolean> {
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
    if (actions?.openConfig) {
      await actions.openConfig();
    } else {
      console.log("config screen unavailable");
    }
    return false;
  }

  if (cmd === "/skill") {
    const sub = (args[0] || "").trim().toLowerCase();
    if (!sub || sub === "list") {
      const installed = await listInstalledSkills(ctx.state.projectRoot);
      if (!installed.global.length) {
        console.log("(no skills installed)");
        return false;
      }
      console.log("global skills:");
      for (const sk of installed.global) console.log(`- ${sk.name} (${sk.path})`);
      return false;
    }
    if (sub === "add") {
      const rawPath = args.slice(1).join(" ").trim();
      const sourcePath = resolveSkillSourcePath(ctx.state.projectRoot, rawPath);
      if (!sourcePath) {
        console.log("usage: /skill add <path/to/SKILL.md>");
        return false;
      }
      try {
        const installed = await installSkillFromFile({
          projectRoot: ctx.state.projectRoot,
          sourcePath
        });
        console.log(`skill installed: ${installed.name} -> ${installed.destPath} (${installed.bytes} bytes)`);
      } catch (err) {
        console.log(`skill install failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
    console.log("usage: /skill add <path/to/SKILL.md> OR /skill list");
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
  if (trimmed === "/skill" || trimmed === "/skill ") {
    return [["add", "list"], ""];
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
  if (tokens[0] === "/skill" && tokens.length === 2) {
    return [["add", "list"].filter((v) => v.startsWith(current)), current];
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

function buildHeaderPanel(state: ForgeState, cols: number, logoLines?: string[] | null): string[] {
  const width = Math.max(60, Math.min(cols - 2, 120));
  const inner = width - 2;
  const leftW = Math.floor(inner * 0.46);
  const rightW = inner - leftW - 1;

  const logo = (logoLines && logoLines.length)
    ? logoLines
    : [
      "      ██╗███╗   ██╗",
      "      ██║████╗  ██║",
      "      ██║██╔██╗ ██║",
      "      ██║██║╚██╗██║",
      "      ██║██║ ╚████║",
      "      ╚═╝╚═╝  ╚═══╝"
    ];

  const leftLines = [
    `${C.white}Welcome back!${C.reset}`,
    "",
    ...logo.map((l) => `${C.green}${l}${C.reset}`),
    "",
    `${C.gray}${state.provider.provider} • ${state.provider.model}${C.reset}`,
    `${C.gray}${state.projectRoot}${C.reset}`
  ];

  const rightLines = [
    `${C.white}Tips for getting started${C.reset}`,
    `${C.gray}Ask Forge to create a new app or clone a repository${C.reset}`,
    "",
    `${C.white}Recent activity${C.reset}`,
    `${C.gray}No recent activity${C.reset}`,
    "",
    `${C.gray}Type /help for commands • Shift+Tab toggles shell${C.reset}`
  ];

  const height = Math.max(leftLines.length, rightLines.length);
  const out: string[] = [];
  out.push(`${C.yellow}┌${"─".repeat(leftW)}┬${"─".repeat(rightW)}┐${C.reset}`);
  for (let i = 0; i < height; i++) {
    const l = leftLines[i] || "";
    const r = rightLines[i] || "";
    out.push(`${C.yellow}│${C.reset}${padAnsi(truncateAnsi(l, leftW), leftW)}${C.yellow}│${C.reset}${padAnsi(truncateAnsi(r, rightW), rightW)}${C.yellow}│${C.reset}`);
  }
  out.push(`${C.yellow}└${"─".repeat(leftW)}┴${"─".repeat(rightW)}┘${C.reset}`);
  const safeCols = Math.max(0, cols - 1);
  return out.map((l) => padAnsi(truncateAnsi(l, safeCols), safeCols));
}

function buildInputPanel(args: {
  cols: number;
  mode: "chat" | "shell" | "modal";
  line: string;
  cursor: number;
  ghostSuffix: string;
  ctx: ChatContext;
  thinking: string;
  selectedIndex: number;
  modalLabel?: string;
}): { lines: string[] } {
  const cols = args.cols;
  const safeCols = Math.max(20, cols - 1); // never touch last col
  const innerWidth = Math.max(44, Math.min(120, safeCols - 4));
  const label = args.mode === "shell" ? " shell " : args.mode === "modal" ? ` ${args.modalLabel || "confirm"} ` : " chat ";
  const top = `${C.gray}┌─${C.reset}${C.white}${label}${C.reset}${C.gray}${"─".repeat(Math.max(0, innerWidth - (label.length + 2)))}┐${C.reset}`;
  const bottom = `${C.gray}└${"─".repeat(innerWidth)}┘${C.reset}`;

  const yolo = (args.ctx.state.executionMode === "yolo");
  const prefixPlain = `${yolo ? "*" : "›"} `;
  const prefixStyled = yolo ? `\x1b[31m*\x1b[0m ` : prefixPlain;
  const maxTextWidth = Math.max(1, innerWidth - 4);
  const cursor = Math.max(0, Math.min(args.cursor, args.line.length));
  const showGhost = Boolean(args.ghostSuffix) && cursor >= args.line.length;
  const displayText = showGhost ? `${args.line}${args.ghostSuffix}` : args.line;
  const viewStart = Math.max(0, cursor - maxTextWidth + 1);
  const viewText = displayText.slice(viewStart, viewStart + maxTextWidth);
  const typedVisible = args.line.slice(viewStart, viewStart + maxTextWidth);
  const typedLenInView = Math.max(0, Math.min(cursor - viewStart, typedVisible.length));

  const contentWidth = Math.max(0, (innerWidth - 2) - prefixPlain.length);
  const contentPlain = viewText.padEnd(contentWidth, " ");
  const contentCursor = Math.max(0, Math.min(contentPlain.length, typedLenInView));
  const before = contentPlain.slice(0, contentCursor);
  const after = contentPlain.slice(contentCursor + 1);
  const cursorCell = `\x1b[7m${contentPlain[contentCursor] || " "}\x1b[0m`;
  const mid = `${C.gray}│${C.reset} ${prefixStyled}${before}${cursorCell}${after}${C.gray}│${C.reset}`;

  const trimmed = args.line.trimStart();
  const showShortcuts = trimmed === "?" || trimmed === "? ";
  const helpLine = args.thinking
    ? `${C.yellow}${args.thinking}${C.reset} ${C.gray}ai is responding… (Esc/Ctrl+C to stop)${C.reset}`
    : `${C.dim}?${C.reset} ${C.gray}for shortcuts${C.reset}`;
  const statusAbove = args.thinking ? helpLine : "";

  const suggestionLines: string[] = [];
  if (showShortcuts) {
    const shortcuts = [
      [`Shift+Tab`, `toggle input mode (chat ↔ shell)`],
      [`Ctrl+Y`, `toggle yolo mode`],
      [`Ctrl+V`, `paste clipboard image as attachment`],
      [`PageUp/PageDown`, `scroll output`],
      [`Mouse Wheel`, `scroll output`],
      [`Esc/Ctrl+C`, `stop AI while responding`],
    ];
    const keyW = Math.min(18, Math.max(12, Math.floor(safeCols * 0.28)));
    const descW = Math.max(0, safeCols - keyW - 4);
    for (const [k, d] of shortcuts) {
      const left = padAnsi(truncateAnsi(k, keyW), keyW);
      const right = truncateAnsi(d, descW);
      suggestionLines.push(padAnsi(truncateAnsi(`${C.cyan}${left}${C.reset}  ${C.gray}${right}${C.reset}`, safeCols), safeCols));
    }
  } else if (trimmed.startsWith("/")) {
    const [suggestions] = completeLine(trimmed, args.ctx);
    const items = suggestions.slice(0, 8);
    const selected = Math.max(0, Math.min(args.selectedIndex, Math.max(0, items.length - 1)));
    const cmdW = Math.min(18, Math.max(10, Math.floor(safeCols * 0.25)));
    const descW = Math.max(0, safeCols - cmdW - 4);
    const isArgCompletion = /\s/.test(trimmed);
    for (let i = 0; i < items.length; i++) {
      const raw = String(items[i] || "");
      const name = raw.startsWith("/") ? raw.slice(1) : raw;
      const leftText = isArgCompletion ? name : `/${name}`;
      const desc = isArgCompletion ? "" : (COMMAND_DESCRIPTIONS[`/${name}`] || "");
      const left = padAnsi(truncateAnsi(leftText, cmdW), cmdW);
      const right = truncateAnsi(desc, descW);
      const row = `${left}  ${C.gray}${right}${C.reset}`;
      if (i === selected) {
        suggestionLines.push(padAnsi(truncateAnsi(`\x1b[7m${row}\x1b[0m`, safeCols), safeCols));
      } else {
        suggestionLines.push(padAnsi(truncateAnsi(row, safeCols), safeCols));
      }
    }
  }

  const lines = [
    padAnsi(truncateAnsi(statusAbove, safeCols), safeCols),
    padAnsi(truncateAnsi(top, safeCols), safeCols),
    padAnsi(truncateAnsi(mid, safeCols), safeCols),
    padAnsi(truncateAnsi(bottom, safeCols), safeCols),
    padAnsi(truncateAnsi(args.thinking ? "" : helpLine, safeCols), safeCols),
    ...suggestionLines,
  ];
  return { lines };
}

function getConfigActions(): Array<{ key: ConfigActionKey; label: string }> {
  return [
    { key: "provider", label: "Provider" },
    { key: "apikey", label: "API key" },
    { key: "model", label: "Model" },
    { key: "endpoint", label: "Endpoint" },
    { key: "browserpath", label: "Browser path" },
    { key: "searchmode", label: "Search mode" },
    { key: "projectroot", label: "Project root" },
    { key: "execmode", label: "Execution mode" },
    { key: "save", label: "Save and exit" },
    { key: "cancel", label: "Cancel" },
  ];
}

function formatConfigValue(state: ForgeState, key: ConfigActionKey): string {
  if (key === "provider") return state.provider.provider;
  if (key === "apikey") return state.provider.provider === "ollama" ? "(not required)" : (state.apiKeys[state.provider.provider] ? "********" : "(not set)");
  if (key === "model") return state.provider.model || "(empty)";
  if (key === "endpoint") return state.provider.endpoint || (state.provider.provider === "ollama" ? "http://127.0.0.1:11434" : "(none)");
  if (key === "browserpath") return state.browserExecutablePath || "(default playwright chromium)";
  if (key === "searchmode") return state.searchMode || "safe";
  if (key === "projectroot") return state.projectRoot;
  if (key === "execmode") return state.executionMode || "safe";
  return "";
}

function buildConfigPanel(cols: number, rows: number, screen: ConfigScreenState): string[] {
  const safeCols = Math.max(20, cols - 1);
  const panelW = Math.max(64, Math.min(108, safeCols - 4));
  const leftPad = Math.max(0, Math.floor((safeCols - panelW) / 2));
  const padLeft = (s: string) => `${" ".repeat(leftPad)}${s}`;
  const actions = getConfigActions();
  const lines: string[] = [];
  lines.push("");
  lines.push(padLeft(`${C.yellow}┌${"─".repeat(panelW)}┐${C.reset}`));
  lines.push(padLeft(`${C.yellow}│${C.reset}${padAnsi(`${C.white} Forge Config ${C.reset}${C.gray}interactive setup${C.reset}`, panelW)}${C.yellow}│${C.reset}`));
  lines.push(padLeft(`${C.yellow}├${"─".repeat(panelW)}┤${C.reset}`));

  const labelW = 16;
  const valueW = Math.max(10, panelW - labelW - 5);
  for (let i = 0; i < actions.length; i++) {
    const item = actions[i];
    const selected = i === screen.selectedIndex;
    const marker = selected ? `${C.cyan}>${C.reset}` : " ";
    const value = formatConfigValue(screen.working, item.key);
    const body = item.key === "save" || item.key === "cancel"
      ? `${marker} ${item.label}`
      : `${marker} ${padAnsi(truncateAnsi(item.label, labelW), labelW)} ${C.gray}${truncateAnsi(value, valueW)}${C.reset}`;
    const row = selected ? `\x1b[7m${padAnsi(body, panelW)}\x1b[0m` : padAnsi(body, panelW);
    lines.push(padLeft(`${C.yellow}│${C.reset}${row}${C.yellow}│${C.reset}`));
  }

  lines.push(padLeft(`${C.yellow}├${"─".repeat(panelW)}┤${C.reset}`));
  if (screen.mode === "edit" && screen.editingField) {
    const title = `Editing ${getConfigActions().find((item) => item.key === screen.editingField)?.label || screen.editingField}`;
    const preview = screen.editingField === "apikey" ? "*".repeat(screen.editBuffer.length) : screen.editBuffer || " ";
    lines.push(padLeft(`${C.yellow}│${C.reset}${padAnsi(`${C.white}${title}${C.reset}`, panelW)}${C.yellow}│${C.reset}`));
    lines.push(padLeft(`${C.yellow}│${C.reset}${padAnsi(preview, panelW)}${C.yellow}│${C.reset}`));
    lines.push(padLeft(`${C.yellow}│${C.reset}${padAnsi(`${C.gray}Enter saves this field. Esc cancels edit.${C.reset}`, panelW)}${C.yellow}│${C.reset}`));
  } else {
    lines.push(padLeft(`${C.yellow}│${C.reset}${padAnsi(`${C.gray}${screen.notice}${C.reset}`, panelW)}${C.yellow}│${C.reset}`));
    lines.push(padLeft(`${C.yellow}│${C.reset}${padAnsi(`${C.gray}Left/Right cycles provider, search mode, and execution mode.${C.reset}`, panelW)}${C.yellow}│${C.reset}`));
    lines.push(padLeft(`${C.yellow}│${C.reset}${padAnsi(`${C.gray}Enter edits text fields or activates save/cancel.${C.reset}`, panelW)}${C.yellow}│${C.reset}`));
  }
  lines.push(padLeft(`${C.yellow}└${"─".repeat(panelW)}┘${C.reset}`));

  const out: string[] = [];
  const topPad = Math.max(0, Math.floor((rows - lines.length) / 2));
  for (let i = 0; i < topPad; i++) out.push("");
  out.push(...lines);
  while (out.length < rows) out.push("");
  return out.slice(0, rows);
}

function clearRecentlyEchoedRows(rows: number): void {
  if (!process.stdout.isTTY || rows <= 0) return;
  for (let i = 0; i < rows; i++) {
    process.stdout.write("\r\x1b[2K");
    if (i < rows - 1) process.stdout.write("\x1b[1A");
  }
  process.stdout.write("\r\x1b[2K");
}

function insertPlaceholderToken(rl: readline.Interface, token: string, mode: string): void {
  const current = String(rl.line || "");
  const next = current.trim().length ? `${current} ${token}` : token;
  rl.write(null, { ctrl: true, name: "u" });
  rl.write(next);
  // Caller handles redraw with ctx for suggestions.
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
  const cols = process.stdout.columns || 110;
  const width = Math.max(86, Math.min(cols - 2, 120));
  const inner = width - 2;
  const leftW = Math.floor(inner * 0.46);
  const rightW = inner - leftW - 1;

  const logo = [
    "      ██╗███╗   ██╗",
    "      ██║████╗  ██║",
    "      ██║██╔██╗ ██║",
    "      ██║██║╚██╗██║",
    "      ██║██║ ╚████║",
    "      ╚═╝╚═╝  ╚═══╝"
  ];

  const leftLines = [
    `${C.white}Welcome back!${C.reset}`,
    "",
    ...logo.map((l) => `${C.yellow}${l}${C.reset}`),
    "",
    `${C.gray}${state.provider.provider} • ${state.provider.model}${C.reset}`,
    `${C.gray}${state.projectRoot}${C.reset}`
  ];

  const rightLines = [
    `${C.white}Tips for getting started${C.reset}`,
    `${C.gray}Ask Forge to create a new app or clone a repository${C.reset}`,
    "",
    `${C.white}Recent activity${C.reset}`,
    `${C.gray}No recent activity${C.reset}`,
    "",
    `${C.gray}Type /help for commands • Right/End accepts ghost${C.reset}`
  ];

  const height = Math.max(leftLines.length, rightLines.length);
  console.log(`${C.yellow}┌${"─".repeat(leftW)}┬${"─".repeat(rightW)}┐${C.reset}`);
  for (let i = 0; i < height; i++) {
    const l = leftLines[i] || "";
    const r = rightLines[i] || "";
    console.log(
      `${C.yellow}│${C.reset}${padAnsi(truncateAnsi(l, leftW), leftW)}${C.yellow}│${C.reset}${padAnsi(truncateAnsi(r, rightW), rightW)}${C.yellow}│${C.reset}`
    );
  }
  console.log(`${C.yellow}└${"─".repeat(leftW)}┴${"─".repeat(rightW)}┘${C.reset}`);
  console.log("");
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncateAnsi(s: string, width: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= width) return s;
  // Best-effort: truncate plain text, keep it unstyled to avoid broken escape sequences.
  return plain.slice(0, width);
}

function padAnsi(s: string, width: number): string {
  const len = stripAnsi(s).length;
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

function wrapAnsiLine(s: string, width: number): string[] {
  if (width <= 0) return [""];
  const plain = stripAnsi(s);
  if (!plain.length) return [""];
  const out: string[] = [];
  for (let i = 0; i < plain.length; i += width) out.push(plain.slice(i, i + width));
  return out;
}

async function tryRenderForgeSvgAscii(targetW: number, targetH: number): Promise<string[] | null> {
  try {
    const candidates = [
      join(__dirname, "../../../../assets/Forge.svg"),
      join(__dirname, "../../../../src/assets/Forge.svg"),
      join(process.cwd(), "assets/Forge.svg"),
      join(process.cwd(), "src/assets/Forge.svg"),
    ];
    let svg: string | null = null;
    for (const p of candidates) {
      try {
        svg = await readFile(p, "utf8");
        break;
      } catch {
        // try next
      }
    }
    if (!svg) return null;
    const raster = await svgToAsciiViaPlaywright(svg, targetW, targetH).catch(() => null);
    return raster && raster.length ? raster : svgRectsToAscii(svg, targetW, targetH);
  } catch {
    return null;
  }
}

async function svgToAsciiViaPlaywright(svg: string, w: number, h: number): Promise<string[]> {
  const mod = await import("playwright");
  const chromium = (mod as any).chromium;
  if (!chromium) return [];

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;">
  <div id="wrap" style="width:512px;height:512px;display:flex;align-items:center;justify-content:center;">
    ${svg.replace(/fill="white"/gi, 'fill="#ffffff"')}
  </div>
</body>
</html>`;
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const pixels = await (page as any).evaluate(async ({ outW, outH }: any) => {
      const document: any = (globalThis as any).document;
      const XMLSerializer: any = (globalThis as any).XMLSerializer;
      const Image: any = (globalThis as any).Image;
      const Blob: any = (globalThis as any).Blob;
      const URL: any = (globalThis as any).URL;

      const svgEl = document?.querySelector?.("svg");
      if (!svgEl) return null;
      // Serialize SVG into an image.
      const serializer = new XMLSerializer();
      const svgText = serializer.serializeToString(svgEl);
      const blob = new Blob([svgText], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);

      const cellW = 8;
      const cellH = 16;
      const cw = outW * cellW;
      const ch = outH * cellH;
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;

      const out: number[][] = Array.from({ length: outH }, () => Array(outW).fill(0));
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          let sum = 0;
          let n = 0;
          for (let yy = 0; yy < cellH; yy++) {
            for (let xx = 0; xx < cellW; xx++) {
              const px = x * cellW + xx;
              const py = y * cellH + yy;
              const idx = (py * cw + px) * 4;
              const r = data[idx];
              const g = data[idx + 1];
              const b = data[idx + 2];
              const a = data[idx + 3];
              if (a < 10) continue;
              // Luma
              sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
              n++;
            }
          }
          out[y][x] = n ? sum / (n * 255) : 0;
        }
      }
      return out;
    }, { outW: w, outH: h });

    if (!pixels) return [];
    const on = "█";
    const off = " ";
    return pixels.map((row: number[]) => row.map((v) => (v > 0.15 ? on : off)).join("").replace(/\s+$/g, ""));
  } finally {
    await browser.close();
  }
}

function svgRectsToAscii(svg: string, w: number, h: number): string[] {
  const vb = svg.match(/viewBox="([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)"/i);
  if (!vb) return [];
  const vbX = Number(vb[1] || 0);
  const vbY = Number(vb[2] || 0);
  const vbW = Number(vb[3] || 1);
  const vbH = Number(vb[4] || 1);

  const rectRe = /<rect\s+([^>]+?)\s*\/?>/gi;
  const rects: Array<{ x: number; y: number; w: number; h: number; rot?: { deg: number; cx: number; cy: number } }> = [];
  let m: RegExpExecArray | null;
  while ((m = rectRe.exec(svg))) {
    const attrs = m[1] || "";
    const get = (name: string) => {
      const mm = attrs.match(new RegExp(`${name}=\"([0-9.]+)\"`, "i"));
      return mm ? Number(mm[1]) : NaN;
    };
    const x = get("x");
    const y = get("y");
    const rw = get("width");
    const rh = get("height");
    if (!Number.isFinite(rw) || !Number.isFinite(rh)) continue;
    const transform = attrs.match(/transform=\"rotate\\(([-0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)\\)\"/i);
    const rot = transform
      ? { deg: Number(transform[1] || 0), cx: Number(transform[2] || 0), cy: Number(transform[3] || 0) }
      : undefined;
    rects.push({ x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, w: rw, h: rh, rot });
  }

  const grid: boolean[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => false));

  const invRotate = (px: number, py: number, rot?: { deg: number; cx: number; cy: number }) => {
    if (!rot) return { x: px, y: py };
    const rad = (-rot.deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const tx = px - rot.cx;
    const ty = py - rot.cy;
    const nx = tx * cos - ty * sin;
    const ny = tx * sin + ty * cos;
    return { x: nx + rot.cx, y: ny + rot.cy };
  };

  // Sample cell centers in viewBox space and test membership in each rect.
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const u = (gx + 0.5) / w;
      const v = (gy + 0.5) / h;
      const px = vbX + u * vbW;
      const py = vbY + v * vbH;
      let on = false;
      for (const r of rects) {
        const p = invRotate(px, py, r.rot);
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
          on = true;
          break;
        }
      }
      grid[gy][gx] = on;
    }
  }

  const on = "█";
  const off = " ";
  return grid.map((row) => row.map((v) => (v ? on : off)).join("").replace(/\s+$/g, ""));
}

function renderSquareLogo(lines: string[], outW: number, outH: number): string[] {
  const srcH = lines.length;
  const srcW = Math.max(0, ...lines.map((l) => stripAnsi(l).length));
  if (!srcW || !srcH || outW <= 0 || outH <= 0) return [];

  const src: boolean[][] = Array.from({ length: srcH }, (_, y) => {
    const row = stripAnsi(lines[y] || "").padEnd(srcW, " ");
    return Array.from(row, (ch) => ch !== " " && ch !== "\t");
  });

  const dst: string[] = [];
  for (let y = 0; y < outH; y++) {
    let row = "";
    const y0 = Math.floor((y * srcH) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * srcW) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / outW));
      let on = 0;
      let total = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          total++;
          if (src[yy]?.[xx]) on++;
        }
      }
      row += on / Math.max(1, total) > 0.35 ? "█" : " ";
    }
    dst.push(row.replace(/\s+$/g, ""));
  }

  // Trim empty rows.
  while (dst.length && !dst[0].trim()) dst.shift();
  while (dst.length && !dst[dst.length - 1].trim()) dst.pop();
  return dst;
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
    "/skill add <path/to/SKILL.md> | /skill list",
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

async function handleConfigKeypress(
  str: string,
  key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string },
  screen: ConfigScreenState,
  ctx: ChatContext
): Promise<boolean> {
  const actions = getConfigActions();
  const current = actions[screen.selectedIndex]?.key || "provider";

  if (screen.mode === "edit" && screen.editingField) {
    if (key?.name === "escape") {
      screen.mode = "nav";
      screen.editingField = undefined;
      screen.editBuffer = "";
      screen.notice = "Edit canceled.";
      return true;
    }
    if (key?.name === "return" || key?.name === "enter") {
      commitConfigEdit(screen);
      screen.notice = "Field updated.";
      return true;
    }
    if (key?.name === "backspace") {
      screen.editBuffer = screen.editBuffer.slice(0, -1);
      return true;
    }
    if (key?.ctrl && key?.name === "u") {
      screen.editBuffer = "";
      return true;
    }
    if (typeof str === "string" && str.length === 1 && !key?.ctrl) {
      screen.editBuffer += str;
      return true;
    }
    return true;
  }

  if (key?.name === "up") {
    screen.selectedIndex = Math.max(0, screen.selectedIndex - 1);
    return true;
  }
  if (key?.name === "down") {
    screen.selectedIndex = Math.min(actions.length - 1, screen.selectedIndex + 1);
    return true;
  }
  if (key?.name === "escape") {
    screen.notice = "Config canceled.";
    screen.resolver();
    return true;
  }
  if (key?.name === "left" || key?.name === "right") {
    const dir = key.name === "right" ? 1 : -1;
    if (current === "provider") {
      const idx = PROVIDERS.indexOf(screen.working.provider.provider);
      const next = PROVIDERS[(idx + dir + PROVIDERS.length) % PROVIDERS.length];
      await applyConfigProviderChange(screen, ctx, next);
      return true;
    }
    if (current === "searchmode") {
      const options = ["safe", "manual"] as const;
      const idx = options.indexOf((screen.working.searchMode || "safe") as "safe" | "manual");
      screen.working = { ...screen.working, searchMode: options[(idx + dir + options.length) % options.length] };
      screen.notice = `Search mode set to ${screen.working.searchMode}.`;
      return true;
    }
    if (current === "execmode") {
      const options = ["safe", "yolo"] as const;
      const idx = options.indexOf((screen.working.executionMode || "safe") as "safe" | "yolo");
      screen.working = { ...screen.working, executionMode: options[(idx + dir + options.length) % options.length] };
      screen.notice = `Execution mode set to ${screen.working.executionMode}.`;
      return true;
    }
  }
  if (key?.name === "return" || key?.name === "enter") {
    if (current === "save") {
      await saveConfigScreen(screen, ctx);
      screen.notice = "Config saved.";
      screen.resolver();
      return true;
    }
    if (current === "cancel") {
      screen.notice = "Config canceled.";
      screen.resolver();
      return true;
    }
    if (current === "provider" || current === "searchmode" || current === "execmode") {
      return await handleConfigKeypress("", { name: "right" }, screen, ctx);
    }
    startConfigEdit(screen, current);
    return true;
  }
  return true;
}

function startConfigEdit(screen: ConfigScreenState, field: ConfigFieldKey): void {
  screen.mode = "edit";
  screen.editingField = field;
  if (field === "apikey") screen.editBuffer = "";
  else if (field === "model") screen.editBuffer = screen.working.provider.model || "";
  else if (field === "endpoint") screen.editBuffer = screen.working.provider.endpoint || "";
  else if (field === "browserpath") screen.editBuffer = screen.working.browserExecutablePath || "";
  else if (field === "projectroot") screen.editBuffer = screen.working.projectRoot || "";
}

function commitConfigEdit(screen: ConfigScreenState): void {
  const field = screen.editingField;
  const value = screen.editBuffer.trim();
  if (!field) return;
  if (field === "apikey") {
    if (screen.working.provider.provider !== "ollama" && value) {
      screen.working = setApiKeyInConfig(screen.working, screen.working.provider.provider, value);
    }
  } else if (field === "model" && value) {
    screen.working = setProvider(screen.working, { ...screen.working.provider, model: value });
  } else if (field === "endpoint") {
    screen.working = setProvider(screen.working, { ...screen.working.provider, endpoint: value || undefined });
  } else if (field === "browserpath") {
    screen.working = { ...screen.working, browserExecutablePath: value || undefined };
  } else if (field === "projectroot" && value) {
    screen.working = { ...screen.working, projectRoot: value };
  }
  screen.mode = "nav";
  screen.editingField = undefined;
  screen.editBuffer = "";
}

async function saveConfigScreen(screen: ConfigScreenState, ctx: ChatContext): Promise<void> {
  const nextState = { ...screen.working, onboardingComplete: true };
  ctx.state = nextState;
  await saveState(ctx.state);
  if (ctx.state.projectRoot !== ctx.workspace.projectRoot) {
    ctx.workspace = await loadWorkspace(ctx.state.projectRoot);
  }
  await autoRefreshModels(ctx);
}

async function applyConfigProviderChange(
  screen: ConfigScreenState,
  ctx: ChatContext,
  provider: ProviderKind
): Promise<void> {
  screen.working = setProvider(screen.working, { ...screen.working.provider, provider });
  try {
    const models = await fetchModels(screen.working, provider);
    ctx.modelSuggestions = models;
    if (models.length && !models.includes(screen.working.provider.model)) {
      screen.working = setProvider(screen.working, { ...screen.working.provider, model: models[0] });
      screen.notice = `Provider set to ${provider}. Model auto-selected: ${models[0]}.`;
      return;
    }
    screen.notice = `Provider set to ${provider}.`;
  } catch (err) {
    ctx.modelSuggestions = [];
    screen.notice = `Provider set to ${provider}. Models refresh skipped: ${err instanceof Error ? err.message : String(err)}`;
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
