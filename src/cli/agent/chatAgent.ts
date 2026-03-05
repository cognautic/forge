import type { ForgeState } from "../types";
import { completeText } from "../providers/client";
import {
  click,
  clickAiCursor,
  detectBotChallenge,
  evaluate,
  extract,
  launchBrowser,
  moveAiCursor,
  navigate,
  openGoogleHome,
  readDomText,
  scrollPage,
  searchGoogle,
  setAiCursorVisible,
  setVisualOverlay,
  typeAtCursor
} from "../browser/playwright";
import { readWorkspaceFile, writeWorkspaceFile } from "../core/filesystem";
import { runCommand, runCommandDirect } from "../terminal/exec";
import { systemKeyboardType, systemMouseClick, systemMouseMove, systemOcr, systemScreenshot } from "../system/control";

type ToolCall = { type: "tool"; tool: string; args?: Record<string, unknown> };
type Msg = { type: "message"; content: string };

export async function runAiTurn(
  state: ForgeState,
  userInput: string,
  opts?: {
    signal?: AbortSignal;
    workspaceContext?: string;
    memoryContext?: string;
    confirmAction?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
    onStatus?: (status: string) => void;
    onToolCall?: (tool: string, args: Record<string, unknown>) => void;
    onToolResult?: (tool: string, resultPreview: string) => void;
  }
): Promise<string> {
  const signal = opts?.signal;
  const workspaceContext = opts?.workspaceContext || "Workspace context unavailable.";
  const memoryContext = opts?.memoryContext || "Memory unavailable.";
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("Aborted");
      (err as any).name = "AbortError";
      throw err;
    }
  };
  const searchIntent = isSearchIntent(userInput);
  const osInfo = {
    platform: process.platform,
    arch: process.arch,
    release: process.release?.name || "node",
    display: process.env.DISPLAY || null,
    wayland: process.env.WAYLAND_DISPLAY || null,
    xdgDesktop: process.env.XDG_CURRENT_DESKTOP || null,
    desktopSession: process.env.DESKTOP_SESSION || null
  };
  const system = [
    "You are Cognautic Forge AI with tool access.",
    `Execution mode: ${state.executionMode || "safe"} (safe=request confirmation before each action; yolo=auto-execute all actions).`,
    "Operate as a structured co-worker with internal roles: Architect -> Planner -> Executor -> Reviewer -> Memory Manager.",
    "Use memory context to continue prior work when user asks to continue/resume/finish.",
    "Do not ask for task clarification if memory contains a clear last intent; continue from memory first.",
    "Before acting, infer the active task and lifecycle stage: Proposed/Approved/In Progress/Under Review/Completed/Archived.",
    "Prefer deterministic execution over speculative autonomy.",
    "Always decide yourself whether to call tools.",
    "For search/research requests, you MUST use browser tools and return collected findings.",
    "When searching, ALWAYS use Google via browser.search.",
    "Never claim missing permissions. This runtime has tool access controlled by Forge.",
    "Do not ask the user to grant browser permissions. If browser actions fail, call tools to recover and report the concrete error.",
    `Search mode: ${state.searchMode || "safe"} (safe=try automation + fallback on challenge, manual=open Google and wait for user actions).`,
    "After search, read DOM text and if needed scroll/evaluate/click for more details before final answer.",
    "Decide tool usage autonomously from user intent and tool results.",
    "Respond with EXACTLY ONE JSON object and nothing else.",
    "JSON schema:",
    "{\"type\":\"message\",\"content\":\"...\"}",
    "or",
    "{\"type\":\"tool\",\"tool\":\"browser.search\",\"args\":{\"query\":\"...\"}}",
    "Available tools:",
    "browser.launch { }",
    "browser.goto { url }",
    "browser.search { query }",
    "browser.read_dom { limit }",
    "browser.scroll { pixels }",
    "browser.extract { selector }",
    "browser.click { selector }",
    "browser.eval { script }",
    "browser.overlay_on { }",
    "browser.overlay_off { }",
    "browser.cursor_move { x, y }",
    "browser.cursor_click { button }",
    "browser.cursor_type { text }",
    "browser.cursor_show { }",
    "browser.cursor_hide { }",
    "system.mouse_move { x, y }",
    "system.mouse_click { button }",
    "system.keyboard_type { text }",
    "system.screen_capture { }",
    "system.screen_ocr { image_path }",
    "command.run { command }",
    "system.exec { command }",
    "finish_response { content }",
    "files.read { path }",
    "files.write { path, content }",
    "exec.run { command }",
    "exec.direct { program, args }",
    "",
    "TOOL USAGE GUIDE (FOLLOW STRICTLY):",
    "SAFETY: Do NOT use rfkill. Use nmcli for network/Wi-Fi controls.",
    "1) Prefer exec.direct for system commands.",
    "   - Good: {\"type\":\"tool\",\"tool\":\"exec.direct\",\"args\":{\"program\":\"ls\",\"args\":[\"-la\"]}}",
    "   - Good: {\"type\":\"tool\",\"tool\":\"exec.direct\",\"args\":{\"program\":\"nmcli\",\"args\":[\"radio\",\"wifi\"]}}",
    "   - Bad: shell-only syntax like pipes/redirection in exec.direct args.",
    "2) Use command.run or exec.run only for simple single-line commands where splitting args is hard.",
    "2.1) For long-running commands (e.g. npm install, builds, dev servers), run in background so workflow continues.",
    "     - Prefer: command.run with nohup + redirection + '&'.",
    "     - Example: {\"type\":\"tool\",\"tool\":\"command.run\",\"args\":{\"command\":\"nohup npm install > .forge-data/bg/npm-install.log 2>&1 &\"}}",
    "     - After starting bg task, continue with other tools and optionally inspect logs using files.read.",
    "3) For local UI control tasks:",
    "   a) system.screen_capture -> system.screen_ocr",
    "   b) system.mouse_move/system.mouse_click/system.keyboard_type",
    "   c) repeat capture/ocr to verify results",
    "4) For browser research tasks:",
    "   a) browser.search (Google)",
    "   b) browser.read_dom, browser.scroll, browser.extract/browser.eval",
    "   c) then finish_response with findings",
    "5) ALWAYS end with finish_response { content } when done.",
    "6) finish_response content MUST be a human-readable summary of what you did and what happened.",
    "",
    "COMMON COMMAND RECIPES:",
    "- List files: exec.direct program='ls' args=['-la']",
    "- Wifi status (Linux): exec.direct 'nmcli' ['radio','wifi']",
    "- Wifi off (Linux): exec.direct 'nmcli' ['radio','wifi','off']",
    "- Wifi on (Linux): exec.direct 'nmcli' ['radio','wifi','on']",
    "- Long tasks in background: command.run \"nohup <cmd> > .forge-data/bg/<name>.log 2>&1 &\"",
    "- Read background logs: files.read path='.forge-data/bg/<name>.log'",
    "- If command missing, try alternative tools/commands and report what worked.",
    `Search intent for this user message: ${searchIntent ? "yes" : "no"}`,
    `System info: ${JSON.stringify(osInfo)}`,
    "Workspace snapshot:",
    workspaceContext,
    "Memory snapshot:",
    memoryContext
  ].join("\n");

  let context = `${system}\n\nUser: ${userInput}\n`;
  let stepsSinceFollowUp = 0;
  const maxTotalSteps = Math.min(120, Math.max(1, Math.floor(state.autoContinueMax ?? 20)));
  for (let i = 0; i < maxTotalSteps; i++) {
    throwIfAborted();
    opts?.onStatus?.(`thinking (step ${i + 1})`);
    let raw = "";
    try {
      raw = await completeText(state, context, signal);
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") return "Stopped.";
      throw err;
    }
    throwIfAborted();
    const parsed = parseModelOutput(raw);

    // Enforce tool-first protocol: only finish_response may end the turn.
    if (!parsed) {
      context += `\nParser note: your previous output was invalid. Reply with ONE JSON tool call.\n`;
      continue;
    }

    if (parsed.type === "message") {
      context += `\nProtocol note: do not send plain messages. Use tools and end with finish_response.\n`;
      continue;
    }

    if (parsed.tool === "finish_response") {
      const content = String(parsed.args?.content || "").trim();
      if (looksLikePermissionExcuse(content)) {
        context += "\nPolicy note: do not mention missing permissions. Use tools to attempt the task and report concrete results/errors.\n";
        continue;
      }
      return content || "Action completed.";
    }

    if ((state.executionMode || "safe") !== "yolo" && opts?.confirmAction) {
      const ok = await opts.confirmAction(parsed.tool, parsed.args || {});
      if (!ok) {
        const denial = `action denied by user: ${parsed.tool}`;
        if (!signal?.aborted) opts?.onToolResult?.(parsed.tool, denial);
        context += `\nTool call ${i + 1}: ${JSON.stringify(parsed)}\nTool result ${i + 1}: ${denial}\n`;
        continue;
      }
    }

    throwIfAborted();
    if (!signal?.aborted) opts?.onToolCall?.(parsed.tool, parsed.args || {});
    const toolResult = await executeTool(state, parsed);
    throwIfAborted();
    if (!signal?.aborted) opts?.onToolResult?.(parsed.tool, String(toolResult).slice(0, 260));
    context += `\nTool call ${i + 1}: ${JSON.stringify(parsed)}\nTool result ${i + 1}: ${toolResult}\n`;

    stepsSinceFollowUp++;
    context += "\nAuto-followup: continue the workflow until completion. Do not stop early. Call finish_response only when fully done.\n";
    if (stepsSinceFollowUp >= 6) {
      context += "\nProgress checkpoint: summarize what remains and continue tool execution toward finish_response.\n";
      stepsSinceFollowUp = 0;
    }
  }

  return "Agent hit safety limit before finish_response. Try a narrower request.";
}

async function executeTool(state: ForgeState, call: ToolCall): Promise<string> {
  const args = call.args || {};

  if (call.tool === "browser.launch") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    return "browser launched";
  }

  if (call.tool === "browser.goto") {
    const url = String(args.url || "https://example.com");
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    await navigate(url);
    return `navigated: ${url}`;
  }

  if (call.tool === "browser.search") {
    const query = String(args.query || "");
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    if ((state.searchMode || "safe") === "manual") {
      await openGoogleHome();
      return `manual_mode: opened Google home. Ask user to search "${query}" manually, then continue with browser.read_dom/browser.extract to summarize results.`;
    }
    await searchGoogle(query);
    const chk = await detectBotChallenge();
    if (chk.challenged) {
      await openGoogleHome();
      return `challenge_detected: ${chk.reason || "unknown"} at ${chk.url}. Fallback: ask user to complete captcha/search manually, then continue with browser.read_dom + summarization.`;
    }
    return `searched: ${query}`;
  }

  if (call.tool === "browser.read_dom") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const chk = await detectBotChallenge();
    if (chk.challenged) {
      return `challenge_detected: ${chk.reason || "unknown"} at ${chk.url}. Cannot read meaningful results until user passes challenge.`;
    }
    const limit = Number(args.limit || 6000);
    return await readDomText(limit);
  }

  if (call.tool === "browser.scroll") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const pixels = Number(args.pixels || 1200);
    await scrollPage(pixels);
    return `scrolled ${pixels}`;
  }

  if (call.tool === "browser.extract") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const selector = String(args.selector || "body");
    return await extract(selector);
  }

  if (call.tool === "browser.click") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const selector = String(args.selector || "a");
    await click(selector);
    return `clicked ${selector}`;
  }

  if (call.tool === "browser.eval") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const script = String(args.script || "document.title");
    const out = await evaluate(script);
    return JSON.stringify(out).slice(0, 2000);
  }

  if (call.tool === "browser.overlay_on") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    await setVisualOverlay(true);
    return "overlay enabled";
  }

  if (call.tool === "browser.overlay_off") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    await setVisualOverlay(false);
    return "overlay disabled";
  }

  if (call.tool === "browser.cursor_move") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const x = Number(args.x ?? 120);
    const y = Number(args.y ?? 120);
    await moveAiCursor(x, y);
    return `cursor moved to ${x},${y}`;
  }

  if (call.tool === "browser.cursor_click") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const button = String(args.button || "left") as "left" | "right" | "middle";
    await clickAiCursor(button);
    return `cursor clicked ${button}`;
  }

  if (call.tool === "browser.cursor_type") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const text = String(args.text || "");
    await typeAtCursor(text);
    return `cursor typed ${text.length} chars`;
  }

  if (call.tool === "browser.cursor_show") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    await setAiCursorVisible(true);
    return "browser ai cursor shown";
  }

  if (call.tool === "browser.cursor_hide") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    await setAiCursorVisible(false);
    return "browser ai cursor hidden";
  }

  if (call.tool === "system.mouse_move") {
    const x = Number(args.x ?? 100);
    const y = Number(args.y ?? 100);
    return await systemMouseMove(x, y);
  }

  if (call.tool === "system.mouse_click") {
    const button = String(args.button || "left") as "left" | "right" | "middle";
    return await systemMouseClick(button);
  }

  if (call.tool === "system.keyboard_type") {
    const text = String(args.text || "");
    return await systemKeyboardType(text);
  }

  if (call.tool === "system.screen_capture") {
    const path = await systemScreenshot(".forge-data/screens");
    return `screenshot saved: ${path}`;
  }

  if (call.tool === "system.screen_ocr") {
    const imagePath = String(args.image_path || "");
    if (!imagePath) return "missing image_path";
    return await systemOcr(imagePath);
  }

  if (call.tool === "system.exec") {
    const command = String(args.command || "");
    if (!command) return "missing command";
    const blocked = blockedCommandMessage(commandProgram(command));
    if (blocked) return blocked;
    const r = await runCommand(command, state.projectRoot);
    return `exit=${r.code}\n${r.output.slice(0, 1200)}`;
  }

  if (call.tool === "command.run") {
    const command = String(args.command || "");
    if (!command) return "missing command";
    const blocked = blockedCommandMessage(commandProgram(command));
    if (blocked) return blocked;
    const r = await runCommand(command, state.projectRoot);
    return `exit=${r.code}\n${r.output.slice(0, 1200)}`;
  }

  if (call.tool === "files.read") {
    const path = String(args.path || "");
    try {
      const data = await readWorkspaceFile(state.projectRoot, path);
      return data.slice(0, 1500);
    } catch (err) {
      return `files.read failed: ${err instanceof Error ? err.message : String(err)}. Hint: use a path inside projectRoot=${state.projectRoot} or change /root.`;
    }
  }

  if (call.tool === "files.write") {
    const path = String(args.path || "");
    const content = String(args.content || "");
    try {
      await writeWorkspaceFile(state.projectRoot, path, content);
      return `wrote ${path}`;
    } catch (err) {
      return `files.write failed: ${err instanceof Error ? err.message : String(err)}. Hint: use a path inside projectRoot=${state.projectRoot} or change /root.`;
    }
  }

  if (call.tool === "exec.run") {
    const command = String(args.command || "echo missing command");
    const blocked = blockedCommandMessage(commandProgram(command));
    if (blocked) return blocked;
    const r = await runCommand(command, state.projectRoot);
    return `exit=${r.code}\n${r.output.slice(0, 1200)}`;
  }

  if (call.tool === "exec.direct") {
    const program = String(args.program || "");
    const argv = Array.isArray(args.args) ? args.args.map((x) => String(x)) : [];
    if (!program) return "missing program";
    const blocked = blockedCommandMessage(program);
    if (blocked) return blocked;
    const r = await runCommandDirect(program, argv, state.projectRoot);
    return `exit=${r.code}\n${r.output.slice(0, 1200)}`;
  }

  return `unknown tool: ${call.tool}`;
}

function parseModelOutput(raw: string): ToolCall | Msg | null {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```/, "").replace(/```$/, "").trim();

  // Fast path: direct JSON object.
  try {
    const direct = JSON.parse(cleaned) as ToolCall | Msg;
    if (isValidEnvelope(direct)) return direct;
  } catch {
    // Fall through to extraction.
  }

  // Recovery path: extract first valid JSON object from mixed text.
  const objs = extractJsonObjects(cleaned);
  for (const obj of objs) {
    try {
      const parsed = JSON.parse(obj) as ToolCall | Msg;
      if (isValidEnvelope(parsed)) return parsed;
    } catch {
      // Keep scanning.
    }
  }

  return null;
}

function isSearchIntent(input: string): boolean {
  return /\b(search|research|look up|find info|learn about|what is|who is|latest|news about)\b/i.test(input);
}

function looksLikePermissionExcuse(text: string): boolean {
  return /(unable|cannot|can't|does not have|don't have).{0,80}(permission|permissions)/i.test(text)
    || /grant.{0,40}(permission|permissions)/i.test(text)
    || /browser.{0,40}(permission|permissions)/i.test(text);
}

function isValidEnvelope(v: unknown): v is ToolCall | Msg {
  if (!v || typeof v !== "object") return false;
  const t = (v as any).type;
  if (t === "message") return typeof (v as any).content === "string";
  if (t === "tool") return typeof (v as any).tool === "string";
  return false;
}

function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === "\"") {
        inStr = false;
      }
      continue;
    }

    if (ch === "\"") {
      inStr = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return out;
}

function sanitizeFallback(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "I could not produce a valid response.";
  if (trimmed.length > 2000) return `${trimmed.slice(0, 2000)}...`;
  return trimmed;
}

function commandProgram(command: string): string {
  return command.trim().split(/\s+/)[0] || "";
}

function blockedCommandMessage(program: string): string | null {
  const normalized = program.trim().toLowerCase().split("/").pop() || "";
  if (normalized === "rfkill") {
    return "blocked: rfkill is disabled for safety. Use nmcli instead (e.g., 'nmcli radio wifi on|off' or 'nmcli radio wifi').";
  }
  return null;
}
