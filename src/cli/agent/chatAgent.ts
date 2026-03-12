import type { ForgeState } from "../types";
import { completeText } from "../providers/client";
import {
  click,
  clickAiCursor,
  detectBotChallenge,
  evaluate,
  extract,
  findTextPatterns,
  launchBrowser,
  moveAiCursor,
  navigate,
  observeBrowserState,
  openGoogleHome,
  readDomText,
  resetBrowser,
  scrollPage,
  searchDuckDuckGo,
  searchGoogle,
  setAiCursorVisible,
  setVisualOverlay,
  typeAtCursor
} from "../browser/playwright";
import { readWorkspaceFile, writeWorkspaceFile } from "../core/filesystem";
import { runCommand, runCommandDirect } from "../terminal/exec";
import { systemKeyboardType, systemMouseClick, systemMouseMove, systemOcr, systemScreenshot } from "../system/control";
import { callMcpTool, listMcpTools } from "../mcp/client";
import { executeTool as executeGoogleTool, getAllTools as getAllGoogleTools } from "../../integrations/google";

type ToolCall = { type: "tool"; tool: string; args?: Record<string, unknown> };
type Msg = { type: "message"; content: string };
type PlanStatus = "pending" | "in_progress" | "completed";
type PlanStep = { step: string; status: PlanStatus };
let lastWebSearchAt = 0;

export async function runAiTurn(
  state: ForgeState,
  userInput: string,
  opts?: {
    signal?: AbortSignal;
    skillsContext?: string;
    skillsFiles?: {
      globalAbsolute?: string[];
    };
    workspaceContext?: string;
    memoryContext?: string;
    confirmAction?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
    onStatus?: (status: string) => void;
    onToolCall?: (tool: string, args: Record<string, unknown>) => void;
    onToolResult?: (tool: string, resultPreview: string) => void;
    onPlanUpdate?: (update: { explanation?: string; steps: PlanStep[] }) => void;
    onUserWait?: (request: { reason: string; prompt?: string; timeoutSeconds?: number | null }) => Promise<string>;
  }
): Promise<string> {
  const mcpTools = await listMcpTools(state);
  const googleTools = getAllGoogleTools();
  const signal = opts?.signal;
  const skillsContext = opts?.skillsContext || "(none)";
  const globalSkillFiles = (opts?.skillsFiles?.globalAbsolute || [])
    .map((p) => String(p || "").trim())
    .filter(Boolean);
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
  const now = new Date();
  const system = [
    "You are Cognautic Forge AI with tool access.",
    `Current system date/time: ${now.toString()}`,
    `Current system ISO timestamp: ${now.toISOString()}`,
    `Execution mode: ${state.executionMode || "safe"} (safe=request confirmation before each action; yolo=auto-execute all actions).`,
    "Operate as a structured co-worker with internal roles: Architect -> Planner -> Executor -> Reviewer -> Memory Manager.",
    "Before taking any action, read the entire Skills section(s) (if present) and follow them as mandatory instructions.",
    "If the user request appears to match an available skill (e.g. design/redesign/UI/UX), you MUST read the relevant skill file(s) via files.read before starting the work.",
    "Use memory context to continue prior work when user asks to continue/resume/finish.",
    "Do not ask for task clarification if memory contains a clear last intent; continue from memory first.",
    "Before acting, infer the active task and lifecycle stage: Proposed/Approved/In Progress/Under Review/Completed/Archived.",
    "Prefer deterministic execution over speculative autonomy.",
    "Always decide yourself whether to call tools.",
    "For search/research requests, prefer web.search + web.read (no browser). Use browser tools only as fallback.",
    "Prefer direct tools and APIs over browser automation whenever a capable non-browser tool exists.",
    "Do not use browser tools for automations, Google Workspace tasks, or API-capable workflows when Forge has a direct tool path.",
    "If the user asks to do something in Gmail, Google Calendar, Drive, Docs, Sheets, Tasks, Contacts, or Meet, prefer google.* tools instead of browser automation.",
    "Use browser tools only when there is no direct API/tool path, or when the user explicitly asks for browser/web-UI operation.",
    "Use the built-in browser.* tools as the default browser automation interface.",
    "Use the built-in system.* and cognautic.screen_share tools as the default desktop-control interface.",
    "If a browser workflow is still required and reaches a step only the user can complete, use user.wait to pause the workflow and tell the user to press Enter in Forge after finishing the manual step.",
    "Browser tool results may include browser_notice entries when a popup appears, a new page opens, the URL/title changes, or the DOM changes. Use those notices to decide the next action.",
    "Never claim missing permissions. This runtime has tool access controlled by Forge.",
    "Do not ask the user to grant browser permissions. If browser actions fail, call tools to recover and report the concrete error.",
    `Search mode: ${state.searchMode || "safe"} (safe=try automation + fallback on challenge, manual=open Google and wait for user actions).`,
    "After search, read DOM text and if needed scroll/evaluate/click for more details before final answer.",
    ...(state.mcpServers?.length ? [
      `Configured MCP servers: ${state.mcpServers.map((server) => server.name).join(", ")}`,
      "MCP tools are optional integrations. Use them when clearly suitable, but do not block on MCP if the task can be completed through the app's web UI."
    ] : []),
    "Google Workspace tools are available as google.* function tools after the user connects Google.",
    "Decide tool usage autonomously from user intent and tool results.",
    "Respond with EXACTLY ONE JSON object and nothing else.",
    "JSON schema:",
    "{\"type\":\"message\",\"content\":\"...\"}",
    "or",
    "{\"type\":\"tool\",\"tool\":\"web.search\",\"args\":{\"query\":\"...\"}}",
    "or",
    "{\"type\":\"tool\",\"tool\":\"plans.update\",\"args\":{\"explanation\":\"...\",\"steps\":[{\"step\":\"...\",\"status\":\"pending|in_progress|completed\"}]}}",
    "Available tools:",
    "plans.update { explanation?, steps: [{ step, status }] }",
    "web.search { query }",
    "web.read { url, limit }",
    "browser.launch { }",
    "browser.goto { url }",
    "browser.search { query }",
    "browser.read_dom { limit }",
    "browser.scroll { pixels }",
    "browser.extract { selector }",
    "browser.find_text { pattern, limit? }",
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
    "cognautic.screen_share { }",
    "command.run { command }",
    "system.exec { command }",
    "finish_response { content }",
    "files.read { path }",
    "files.write { path, content }",
    "exec.run { command }",
    "exec.direct { program, args }",
    "mcp.list_tools { }",
    "mcp.call { server, tool, arguments }",
    "user.wait { reason, prompt?, timeout_seconds? }",
    ...(googleTools.length
      ? ["Google tools:", ...googleTools.map((tool) => `google.${tool.name} - ${tool.description}`)]
      : []),
    ...(mcpTools.length
      ? ["MCP tools (configured servers):", ...mcpTools.map((tool) =>
          `mcp.${tool.server}.${tool.name} ${tool.description ? `- ${tool.description}` : ""}`.trim()
        )]
      : []),
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
    "   a) cognautic.screen_share (or system.screen_capture) -> system.screen_ocr",
    "   b) system.mouse_move/system.mouse_click/system.keyboard_type",
    "   c) repeat capture/ocr to verify results",
    "   d) NEVER use command.run/system.exec for screenshots when cognautic.screen_share exists",
    "4) For research tasks (preferred no-browser):",
    "   a) web.search",
    "   b) web.read on relevant result URLs",
    "   c) use browser tools only as fallback",
    "   d) then finish_response with findings",
    "5) Use user.wait when the workflow depends on a manual user action that tools cannot complete.",
    "   - Use it for: login, OAuth consent, captcha solving, 2FA, security prompts, account chooser, permissions approval, or a manual confirmation inside a site/app.",
    "   - When you use it, phrase the wait message so the user knows to return to Forge and press Enter to continue.",
    "   - Good: after opening Google Calendar and reaching the Google sign-in page, call user.wait so the user can log in, return to Forge, and press Enter to continue.",
    "   - Good: if Google search/manual web flow hits a captcha or anti-bot page, call user.wait and tell the user to press Enter after resolving it.",
    "   - Good: if a site requires a one-time manual approval or app authorization popup, call user.wait and tell the user to press Enter afterward.",
    "   - Do not tell the user to click a Forge continue button. Forge waits for Enter in the terminal.",
    "   - Do not use it for ordinary page loads or tool latency. Use normal browser/web tools for that.",
    "   - Do not use it as a substitute for finish_response when the task is already complete.",
    "6) ALWAYS end with finish_response { content } when done.",
    "7) finish_response content MUST be a human-readable summary of what you did and what happened.",
    "8) For non-trivial tasks, start by calling plans.update with a short step list, then keep updating statuses as you complete steps.",
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
    "Skill files (global, absolute):",
    ...(globalSkillFiles.length ? globalSkillFiles : ["(none)"]),
    "Skills snapshot:",
    skillsContext,
    "Workspace snapshot:",
    workspaceContext,
    "Memory snapshot:",
    memoryContext
  ].join("\n");

  let context = `${system}\n\nUser: ${userInput}\n`;
  let stepsSinceFollowUp = 0;
  const pendingSkillReads = new Set<string>();
  const shouldReadDesignSkills = /\b(design|redesign|ui|ux|website|landing\s*page|css|layout|typography|brand)\b/i.test(userInput);
  if (shouldReadDesignSkills && globalSkillFiles.length) {
    for (const p of globalSkillFiles) {
      const lower = p.toLowerCase();
      if (lower.includes("design") || lower.includes("ui") || lower.includes("ux") || lower.includes("frontend") || lower.includes("css")) {
        pendingSkillReads.add(p);
      }
    }
  }

  for (let i = 0; ; i++) {
    throwIfAborted();
    opts?.onStatus?.(`thinking (step ${i + 1})`);
    let raw = "";
    try {
      raw = await completeText(state, context, signal);
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") return "Stopped.";
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 429|Too Many Requests/i.test(msg)) {
        const waitMs = Math.min(15000, 2000 * Math.max(1, i + 1));
        const totalSeconds = Math.ceil(waitMs / 1000);
        for (let remaining = totalSeconds; remaining > 0; remaining--) {
          throwIfAborted();
          opts?.onStatus?.(`rate-limited, retrying in ${remaining}s`);
          await sleep(1000);
        }
        context += `\nRate-limit note: provider returned 429; waited ${waitMs}ms and retrying.\n`;
        i--;
        continue;
      }
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

    if (pendingSkillReads.size) {
      if (parsed.tool !== "files.read") {
        context += `\nSkill enforcement: before calling ${parsed.tool}, you MUST read the relevant skill file(s) first using files.read on each of these paths:\n${[
          ...pendingSkillReads
        ].join("\n")}\n`;
        continue;
      }
      const requested = String(parsed.args?.path || "").trim();
      if (!requested || !pendingSkillReads.has(requested)) {
        context += `\nSkill enforcement: files.read must target one of the required skill paths exactly. Remaining:\n${[
          ...pendingSkillReads
        ].join("\n")}\n`;
        continue;
      }
      // Record that the model actually read the skill, and include the content in context.
      let data = "";
      try {
        data = await readWorkspaceFile(state.projectRoot, requested);
      } catch (err) {
        data = `files.read failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      pendingSkillReads.delete(requested);
      context += `\nSkill read (${requested}):\n${String(data).slice(0, 4000)}\n`;
    }

    if (parsed.tool === "finish_response") {
      const content = String(parsed.args?.content || "").trim();
      if (looksLikePermissionExcuse(content)) {
        context += "\nPolicy note: do not mention missing permissions. Use tools to attempt the task and report concrete results/errors.\n";
        continue;
      }
      return content || "Action completed.";
    }
    if (parsed.tool === "plans.update") {
      const plan = parsePlanUpdateArgs(parsed.args || {});
      if (!plan) {
        context += "\nTool result: plans.update rejected (invalid steps). Provide non-empty steps with statuses pending|in_progress|completed.\n";
        continue;
      }
      if (!signal?.aborted) opts?.onToolCall?.(parsed.tool, parsed.args || {});
      if (!signal?.aborted) opts?.onPlanUpdate?.(plan);
      if (!signal?.aborted) opts?.onToolResult?.(parsed.tool, `updated ${plan.steps.length} steps`);
      context += `\nTool call ${i + 1}: ${JSON.stringify(parsed)}\nTool result ${i + 1}: plan updated (${plan.steps.length} steps)\n`;
      continue;
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
    let toolResult = "";
    try {
      toolResult = await executeTool(state, parsed, { ...opts, signal });
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      toolResult = `tool_error(${parsed.tool}): ${message}`;
    }
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

}

async function executeTool(
  state: ForgeState,
  call: ToolCall,
  opts?: {
    signal?: AbortSignal;
    onUserWait?: (request: { reason: string; prompt?: string; timeoutSeconds?: number | null }) => Promise<string>;
  }
): Promise<string> {
  const args = call.args || {};
  const signal = opts?.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("Aborted");
      (err as any).name = "AbortError";
      throw err;
    }
  };

  if (call.tool === "user.wait") {
    const reason = String(args.reason || "").trim();
    const prompt = String(args.prompt || "").trim();
    const timeoutRaw = Number(args.timeout_seconds);
    const timeoutSeconds = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : null;
    if (!reason) throw new Error("user.wait requires reason");
    if (opts?.onUserWait) {
      return await opts.onUserWait({
        reason,
        prompt: prompt || undefined,
        timeoutSeconds
      });
    }
    if (timeoutSeconds) {
      const start = Date.now();
      while (Date.now() - start < timeoutSeconds * 1000) {
        throwIfAborted();
        await sleep(Math.min(1000, (timeoutSeconds * 1000) - (Date.now() - start)));
      }
      return `waited ${timeoutSeconds}s for manual user action: ${reason}`;
    }
    return `manual user action required: ${reason}`;
  }
  if (call.tool === "mcp.list_tools") {
    return JSON.stringify(await listMcpTools(state));
  }
  if (call.tool === "mcp.call") {
    const server = String(args.server || "").trim();
    const tool = String(args.tool || "").trim();
    if (!server || !tool) throw new Error("mcp.call requires server and tool");
    const toolArgs = args.arguments && typeof args.arguments === "object" ? (args.arguments as Record<string, unknown>) : {};
    return await callMcpTool(state, server, tool, toolArgs);
  }
  if (call.tool.startsWith("mcp.")) {
    const [, serverName, ...toolParts] = call.tool.split(".");
    const toolName = toolParts.join(".");
    if (!serverName || !toolName) throw new Error(`invalid MCP tool name: ${call.tool}`);
    return await callMcpTool(state, serverName, toolName, args);
  }
  if (call.tool.startsWith("google.")) {
    const toolName = call.tool.slice("google.".length);
    const result = await executeGoogleTool(toolName, args, getGoogleUserId());
    return result.success ? JSON.stringify(result.data) : `google_error(${toolName}): ${result.error}`;
  }
  if (call.tool.startsWith("browser.")) {
    return await executeBrowserToolWithRecovery(state, call.tool, args, signal);
  }

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

  if (call.tool === "browser.find_text") {
    await launchBrowser(".forge-data/browser", state.browserExecutablePath);
    const pattern = String(args.pattern || "").trim();
    if (!pattern) throw new Error("browser.find_text requires pattern");
    const limit = Number(args.limit || 10);
    return await findTextPatterns(pattern, limit);
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

  if (call.tool === "cognautic.screen_share") {
    const path = await systemScreenshot(".forge-data/screens");
    return `screen_share saved: ${path}`;
  }

  if (call.tool === "system.screen_ocr") {
    const imagePath = String(args.image_path || "");
    if (!imagePath) return "missing image_path";
    return await systemOcr(imagePath);
  }

  if (call.tool === "web.search") {
    const query = String(args.query || "").trim();
    if (!query) return "missing query";
    await waitForWebSearchSlot();
    let items: Array<{ title: string; url: string }> = [];
    let lastError = "";

    const liteUrl = `https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query }).toString()}`;
    const liteRes = await fetchWithUa(liteUrl, signal);
    if (liteRes.ok) {
      const lite = await liteRes.text();
        items = extractDuckDuckGoResults(lite).slice(0, 10);
      if (!items.length) items = extractExternalUrlsFromHtml(lite).slice(0, 10);
    } else {
      lastError = `HTTP ${liteRes.status}`;
      if (liteRes.status === 429) await sleep(2000);
    }

    if (!items.length) {
      const htmlUrl = `https://duckduckgo.com/html/?${new URLSearchParams({ q: query }).toString()}`;
      const htmlRes = await fetchWithUa(htmlUrl, signal);
      if (htmlRes.ok) {
        const html = await htmlRes.text();
        items = extractDuckDuckGoResults(html).slice(0, 10);
        if (!items.length) items = extractExternalUrlsFromHtml(html).slice(0, 10);
      } else {
        lastError = `HTTP ${htmlRes.status}`;
        if (htmlRes.status === 429) await sleep(2000);
      }
    }

    if (!items.length) {
      const apiUrl = `https://api.duckduckgo.com/?${new URLSearchParams({
        q: query,
        format: "json",
        no_html: "1",
        no_redirect: "1",
        skip_disambig: "1"
      }).toString()}`;
      const apiRes = await fetchWithUa(apiUrl, signal);
      if (apiRes.ok) {
        const apiJson = await apiRes.json();
        items = extractDuckDuckGoApiResults(apiJson).slice(0, 10);
      } else {
        lastError = `HTTP ${apiRes.status}`;
      }
    }

    if (!items.length && lastError.includes("429")) return "web.search failed: HTTP 429 (rate limited)";
    if (!items.length) return "web.search: no results";
    return items.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n");
  }

  if (call.tool === "web.read") {
    const url = String(args.url || "").trim();
    const limit = Math.min(20000, Math.max(500, Number(args.limit || 6000)));
    if (!url) return "missing url";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `web.read failed: invalid url "${url}"`;
    }
    if (!/^https?:$/.test(parsed.protocol)) return "web.read failed: only http/https urls are allowed";
    const res = await fetch(parsed.toString(), {
      signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) return `web.read failed: HTTP ${res.status}`;
    const html = await res.text();
    return htmlToText(html).slice(0, limit);
  }

  if (call.tool === "system.exec") {
    const command = String(args.command || "");
    if (!command) return "missing command";
    const blocked = blockedCommandMessage(commandProgram(command));
    if (blocked) return blocked;
    const r = await runCommand(command, state.projectRoot, signal);
    return `exit=${r.code}\n${r.output.slice(0, 1200)}`;
  }

  if (call.tool === "command.run") {
    const command = String(args.command || "");
    if (!command) return "missing command";
    const blocked = blockedCommandMessage(commandProgram(command));
    if (blocked) return blocked;
    const r = await runCommand(command, state.projectRoot, signal);
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
    const r = await runCommand(command, state.projectRoot, signal);
    return `exit=${r.code}\n${r.output.slice(0, 1200)}`;
  }

  if (call.tool === "exec.direct") {
    const program = String(args.program || "");
    const argv = Array.isArray(args.args) ? args.args.map((x) => String(x)) : [];
    if (!program) return "missing program";
    const blocked = blockedCommandMessage(program);
    if (blocked) return blocked;
    const r = await runCommandDirect(program, argv, state.projectRoot, signal);
    return `exit=${r.code}\n${r.output.slice(0, 1200)}`;
  }

  return `unknown tool: ${call.tool}`;
}

async function executeBrowserToolWithRecovery(
  state: ForgeState,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("Aborted");
      (err as any).name = "AbortError";
      throw err;
    }
  };
  const run = async () => {
    throwIfAborted();
    if (tool === "browser.launch") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      return "browser launched";
    }

    if (tool === "browser.goto") {
      const url = String(args.url || "https://example.com");
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      await navigate(url);
      return `navigated: ${url}`;
    }

    if (tool === "browser.search") {
      const query = String(args.query || "");
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      if ((state.searchMode || "safe") === "manual") {
        await openGoogleHome();
        return `manual_mode: opened Google home. Ask user to search "${query}" manually, then continue with browser.read_dom/browser.extract to summarize results.`;
      }
      await searchDuckDuckGo(query);
      const chkDuck = await detectBotChallenge();
      if (chkDuck.challenged) {
        await searchGoogle(query);
        const chkGoogle = await detectBotChallenge();
        if (chkGoogle.challenged) {
          await openGoogleHome();
          return `challenge_detected: ${chkGoogle.reason || "unknown"} at ${chkGoogle.url}. Fallback: ask user to complete captcha/search manually, then continue with browser.read_dom + summarization.`;
        }
      }
      return `searched: ${query}`;
    }

    if (tool === "browser.read_dom") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const chk = await detectBotChallenge();
      if (chk.challenged) {
        return `challenge_detected: ${chk.reason || "unknown"} at ${chk.url}. Cannot read meaningful results until user passes challenge.`;
      }
      const limit = Number(args.limit || 6000);
      return await readDomText(limit);
    }

    if (tool === "browser.scroll") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const pixels = Number(args.pixels || 1200);
      await scrollPage(pixels);
      return `scrolled ${pixels}`;
    }

    if (tool === "browser.extract") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const selector = String(args.selector || "body");
      return await extract(selector);
    }

    if (tool === "browser.find_text") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const pattern = String(args.pattern || "").trim();
      if (!pattern) throw new Error("browser.find_text requires pattern");
      const limit = Number(args.limit || 10);
      return await findTextPatterns(pattern, limit);
    }

    if (tool === "browser.click") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const selector = String(args.selector || "a");
      await click(selector);
      return `clicked ${selector}`;
    }

    if (tool === "browser.eval") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const script = String(args.script || "document.title");
      const out = await evaluate(script);
      return JSON.stringify(out).slice(0, 2000);
    }

    if (tool === "browser.overlay_on") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      await setVisualOverlay(true);
      return "overlay enabled";
    }

    if (tool === "browser.overlay_off") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      await setVisualOverlay(false);
      return "overlay disabled";
    }

    if (tool === "browser.cursor_move") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const x = Number(args.x ?? 120);
      const y = Number(args.y ?? 120);
      await moveAiCursor(x, y);
      return `cursor moved to ${x},${y}`;
    }

    if (tool === "browser.cursor_click") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const button = String(args.button || "left") as "left" | "right" | "middle";
      await clickAiCursor(button);
      return `cursor clicked ${button}`;
    }

    if (tool === "browser.cursor_type") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      const text = String(args.text || "");
      await typeAtCursor(text);
      return `cursor typed ${text.length} chars`;
    }

    if (tool === "browser.cursor_show") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      await setAiCursorVisible(true);
      return "browser ai cursor shown";
    }

    if (tool === "browser.cursor_hide") {
      await launchBrowser(".forge-data/browser", state.browserExecutablePath);
      await setAiCursorVisible(false);
      return "browser ai cursor hidden";
    }

    return `unknown tool: ${tool}`;
  };

  try {
    const result = await run();
    const notice = await observeBrowserState().catch(() => "");
    return appendBrowserNotice(result, notice);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/has been closed|Target page, context or browser has been closed|context closed|browser closed/i.test(message)) {
      throw err;
    }
    await resetBrowser();
    const result = await run();
    const notice = await observeBrowserState().catch(() => "");
    return appendBrowserNotice(result, notice);
  }
}

function appendBrowserNotice(result: string, notice: string): string {
  const clean = String(notice || "").trim();
  if (!clean) return result;
  return `${result}\n\nbrowser_notice: ${clean}`;
}

function getGoogleUserId(): string {
  return (
    process.env.FORGE_GOOGLE_USER_ID ||
    process.env.USER ||
    process.env.USERNAME ||
    "default"
  );
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

function extractDuckDuckGoApiResults(payload: any): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const push = (title: string, url: string) => {
    const t = String(title || "").trim();
    const normalized = normalizeDuckDuckGoHref(String(url || "").trim());
    if (!t || !normalized || !/^https?:\/\//i.test(normalized)) return;
    if (!isUsableSearchResult(normalized, t)) return;
    out.push({ title: t, url: normalized });
  };

  push(payload?.Heading, payload?.AbstractURL);
  if (Array.isArray(payload?.Results)) {
    for (const r of payload.Results) push(r?.Text, r?.FirstURL);
  }
  const walk = (topics: any[]) => {
    for (const t of topics) {
      if (Array.isArray(t?.Topics)) {
        walk(t.Topics);
      } else {
        push(t?.Text, t?.FirstURL);
      }
    }
  };
  if (Array.isArray(payload?.RelatedTopics)) walk(payload.RelatedTopics);
  return out;
}

function extractDuckDuckGoResults(html: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const re = /<a[^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = decodeHtmlEntities(m[1] || "").trim();
    const title = htmlToText(m[2] || "").replace(/\s+/g, " ").trim();
    const url = normalizeDuckDuckGoHref(href);
    if (!url || !title || title.length < 3) continue;
    if (!isUsableSearchResult(url, title)) continue;
    out.push({ title, url });
  }
  return dedupeResults(out);
}

function normalizeDuckDuckGoHref(href: string): string {
  if (!href) return "";
  if (/^javascript:/i.test(href)) return "";
  if (href.startsWith("//")) href = `https:${href}`;
  if (href.startsWith("http://") || href.startsWith("https://")) {
    try {
      const u = new URL(href);
      if (u.hostname.includes("duckduckgo.com") && u.searchParams.get("uddg")) {
        return decodeURIComponent(u.searchParams.get("uddg") || "");
      }
      return href;
    } catch {
      return href;
    }
  }
  if (!href.startsWith("/l/?")) return "";
  try {
    const u = new URL(`https://duckduckgo.com${href}`);
    return decodeURIComponent(u.searchParams.get("uddg") || "");
  } catch {
    return "";
  }
}

function htmlToText(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeHtmlEntities(text);
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function isUsableSearchResult(url: string, title: string): boolean {
  const t = title.trim().toLowerCase();
  if (t === "here" || t === "more" || t === "duckduckgo") return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return false;
    if (host === "duck.ai" || host.endsWith(".duck.ai")) return false;
    if (host === "www.w3.org" && /\/tr\/html4\/loose\.dtd$/i.test(u.pathname)) return false;
    if (/\.dtd$/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function dedupeResults(items: Array<{ title: string; url: string }>): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string }> = [];
  for (const it of items) {
    const key = it.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function extractExternalUrlsFromHtml(html: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];

  // Prefer DDG redirect targets, which are the actual result URLs.
  const uddgRe = /[?&]uddg=([^&"'<>\\s]+)/gi;
  let um: RegExpExecArray | null;
  while ((um = uddgRe.exec(html))) {
    const decoded = decodeURIComponent(decodeHtmlEntities(um[1] || "").trim());
    const url = normalizeDuckDuckGoHref(decoded);
    if (!url) continue;
    if (!isUsableSearchResult(url, url)) continue;
    out.push({ title: hostTitle(url), url });
  }

  const hrefRe = /href=['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html))) {
    const raw = decodeHtmlEntities(m[1] || "").trim();
    const url = normalizeDuckDuckGoHref(raw);
    if (!url) continue;
    if (!isUsableSearchResult(url, url)) continue;
    out.push({ title: hostTitle(url), url });
  }

  const textUrls = html.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const raw of textUrls) {
    const url = normalizeDuckDuckGoHref(decodeHtmlEntities(raw).trim());
    if (!url) continue;
    if (!isUsableSearchResult(url, url)) continue;
    out.push({ title: hostTitle(url), url });
  }

  return dedupeResults(out);
}

function hostTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "result";
  }
}

function parsePlanUpdateArgs(args: Record<string, unknown>): { explanation?: string; steps: PlanStep[] } | null {
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  const steps: PlanStep[] = [];
  for (const item of rawSteps) {
    if (!item || typeof item !== "object") continue;
    const step = String((item as any).step || "").trim();
    const status = String((item as any).status || "").trim() as PlanStatus;
    if (!step) continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    steps.push({ step, status });
  }
  if (!steps.length) return null;
  const explanation = String(args.explanation || "").trim();
  return explanation ? { explanation, steps } : { steps };
}

async function waitForWebSearchSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, 2000 - (now - lastWebSearchAt));
  if (waitMs > 0) await sleep(waitMs);
  lastWebSearchAt = Date.now();
}

async function fetchWithUa(url: string, signal?: AbortSignal): Promise<Response> {
  return await fetch(url, {
    signal,
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
