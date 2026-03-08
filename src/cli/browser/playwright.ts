import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let context: BrowserContext | null = null;
let page: Page | null = null;
let overlayEnabled = true;
let aiCursorX = 120;
let aiCursorY = 120;
let aiCursorVisible = false;
let launchUserDataDir = ".forge-data/browser";
let launchExecutablePath: string | undefined;
let lastPageSnapshot:
  | {
      url: string;
      title: string;
      modalCount: number;
      pageCount: number;
      bodyHash: number;
    }
  | null = null;
let pendingDialogMessages: string[] = [];

export async function launchBrowser(
  userDataDir = ".forge-data/browser",
  executablePath?: string
): Promise<void> {
  launchUserDataDir = resolveLaunchUserDataDir(userDataDir, executablePath);
  launchExecutablePath = executablePath || undefined;

  if (!context) {
    context = await launchContextOrThrow(launchUserDataDir, executablePath || undefined);
    attachContextObservers(context);
    page = context.pages()[0] ?? (await context.newPage());
    return;
  }

  try {
    if (!page || page.isClosed()) {
      page = context.pages()[0] ?? (await context.newPage());
    }
  } catch {
    context = await launchContextOrThrow(launchUserDataDir, executablePath || undefined);
    attachContextObservers(context);
    page = context.pages()[0] ?? (await context.newPage());
  }
}

export async function resetBrowser(): Promise<void> {
  try {
    await context?.close();
  } catch {
    // best effort reset
  }
  context = null;
  page = null;
  lastPageSnapshot = null;
  pendingDialogMessages = [];
}

async function launchContextOrThrow(userDataDir: string, executablePath?: string): Promise<BrowserContext> {
  try {
    const launched = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        "--disable-dev-shm-usage"
      ]
    });
    await launched.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined
      });
    });
    return launched;
  } catch (err) {
    const msg = String((err as Error)?.message || err || "");
    if (/Executable doesn't exist at/i.test(msg) || /playwright install/i.test(msg)) {
      if (executablePath) {
        throw new Error(
          `chromium path not set or invalid: ${executablePath}. Set a valid browser path using /browserpath </path/to/chrome-or-brave>, or install Playwright Chromium via: npx playwright install chromium`
        );
      }
      throw new Error(
        "chromium path not set. Set browser path using /browserpath </path/to/chrome-or-brave>, or install Playwright Chromium via: npx playwright install chromium"
      );
    }
    throw err;
  }
}

function resolveLaunchUserDataDir(defaultUserDataDir: string, executablePath?: string): string {
  if (!executablePath) return defaultUserDataDir;
  const detected = detectInstalledBrowserUserDataDir(executablePath);
  return detected || defaultUserDataDir;
}

function detectInstalledBrowserUserDataDir(executablePath: string): string | null {
  const normalized = executablePath.toLowerCase();
  const home = homedir();
  const candidates: string[] = [];

  if (process.platform === "linux") {
    if (normalized.includes("brave")) candidates.push(join(home, ".config", "BraveSoftware", "Brave-Browser"));
    if (normalized.includes("chrome")) candidates.push(join(home, ".config", "google-chrome"));
    if (normalized.includes("chromium")) candidates.push(join(home, ".config", "chromium"));
    if (normalized.includes("microsoft-edge") || normalized.includes("msedge")) {
      candidates.push(join(home, ".config", "microsoft-edge"));
    }
  } else if (process.platform === "darwin") {
    if (normalized.includes("brave")) candidates.push(join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"));
    if (normalized.includes("chrome")) candidates.push(join(home, "Library", "Application Support", "Google", "Chrome"));
    if (normalized.includes("chromium")) candidates.push(join(home, "Library", "Application Support", "Chromium"));
    if (normalized.includes("microsoft-edge") || normalized.includes("msedge")) {
      candidates.push(join(home, "Library", "Application Support", "Microsoft Edge"));
    }
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    if (normalized.includes("brave")) candidates.push(join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"));
    if (normalized.includes("chrome")) candidates.push(join(localAppData, "Google", "Chrome", "User Data"));
    if (normalized.includes("chromium")) candidates.push(join(localAppData, "Chromium", "User Data"));
    if (normalized.includes("microsoft-edge") || normalized.includes("msedge")) {
      candidates.push(join(localAppData, "Microsoft", "Edge", "User Data"));
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export async function navigate(url: string): Promise<void> {
  const p = await getPage();
  await p.goto(url, { waitUntil: "domcontentloaded" });
  if (overlayEnabled) await ensureOverlay();
}

export async function click(selector: string): Promise<void> {
  const p = await getPage();
  if (overlayEnabled) await highlightSelector(selector);
  await p.click(selector);
}

export async function moveAiCursor(x: number, y: number): Promise<void> {
  aiCursorX = Math.max(0, Math.floor(x));
  aiCursorY = Math.max(0, Math.floor(y));
  const p = await getPage();
  await ensureOverlay();
  await ensureAiCursor();
  await p.mouse.move(aiCursorX, aiCursorY, { steps: 8 });
  await p.evaluate(
    ({ cx, cy }) => {
      const doc = (globalThis as any).document;
      const el = doc?.getElementById("__forge_ai_cursor");
      if (!el) return;
      el.style.transform = `translate(${cx}px, ${cy}px)`;
    },
    { cx: aiCursorX, cy: aiCursorY }
  );
  await pulseOverlay(`cursor ${aiCursorX},${aiCursorY}`);
}

export async function clickAiCursor(button: "left" | "right" | "middle" = "left"): Promise<void> {
  const p = await getPage();
  await ensureOverlay();
  await ensureAiCursor();
  await p.mouse.move(aiCursorX, aiCursorY, { steps: 3 });
  await p.mouse.down({ button });
  await p.mouse.up({ button });
  await pulseOverlay(`cursor-click ${button}`);
}

export async function typeAtCursor(text: string): Promise<void> {
  const p = await getPage();
  await ensureOverlay();
  await ensureAiCursor();
  await p.keyboard.type(text);
  await pulseOverlay(`cursor-type ${Math.min(text.length, 120)} chars`);
}

export async function extract(selector: string): Promise<string> {
  const p = await getPage();
  return (await p.textContent(selector)) ?? "";
}

export async function findTextPatterns(pattern: string, limit = 10): Promise<string> {
  const p = await getPage();
  if (overlayEnabled) await pulseOverlay("find-text");
  const matches = await p.evaluate(
    ({ pattern, limit }) => {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      const needle = pattern.trim().toLowerCase();
      if (!needle) return [];
      const doc = (globalThis as any).document;
      const elements = Array.from(doc?.querySelectorAll?.("body *") || []);
      const out: Array<{ text: string; tag: string; id: string; classes: string }> = [];
      for (const el of elements) {
        if (out.length >= limit) break;
        const node = el as any;
        const raw = normalize(node.innerText || node.textContent || "");
        if (!raw) continue;
        if (raw.length > 400) continue;
        if (!raw.toLowerCase().includes(needle)) continue;
        out.push({
          text: raw.slice(0, 240),
          tag: node.tagName.toLowerCase(),
          id: node.id || "",
          classes: typeof node.className === "string" ? node.className.trim().slice(0, 120) : ""
        });
      }
      return out;
    },
    { pattern, limit }
  );
  return JSON.stringify(matches).slice(0, 4000);
}

export async function evaluate(script: string): Promise<unknown> {
  const p = await getPage();
  if (overlayEnabled) await pulseOverlay("eval");
  return p.evaluate(script);
}

export async function searchGoogle(query: string): Promise<void> {
  const p = await getPage();
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  await p.goto(url, { waitUntil: "domcontentloaded" });
  if (overlayEnabled) await ensureOverlay();
}

export async function searchDuckDuckGo(query: string): Promise<void> {
  const p = await getPage();
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  await p.goto(url, { waitUntil: "domcontentloaded" });
  if (overlayEnabled) await ensureOverlay();
}

export async function openGoogleHome(): Promise<void> {
  const p = await getPage();
  await p.goto("https://www.google.com", { waitUntil: "domcontentloaded" });
  if (overlayEnabled) await ensureOverlay();
}

export async function detectBotChallenge(): Promise<{ challenged: boolean; reason: string; url: string; title: string }> {
  const p = await getPage();
  const url = p.url();
  const title = await p.title().catch(() => "");
  const signal = await p.evaluate(() => {
    const doc = (globalThis as any).document;
    const body = (doc?.body?.innerText || "").toLowerCase();
    const titleText = (doc?.title || "").toLowerCase();
    const checks = [
      "unusual traffic",
      "verify you are human",
      "i'm not a robot",
      "sorry, but your computer or network may be sending automated queries",
      "captcha",
      "recaptcha",
      "/sorry/"
    ];
    return checks.find((c) => body.includes(c) || titleText.includes(c)) || "";
  });
  const challenged = Boolean(signal) || /\/sorry\//i.test(url);
  return { challenged, reason: signal || (challenged ? "challenge_url" : ""), url, title };
}

export async function scrollPage(pixels = 1200): Promise<void> {
  const p = await getPage();
  if (overlayEnabled) await pulseOverlay("scroll");
  await p.evaluate((p) => {
    (globalThis as any).scrollBy(0, p);
  }, pixels);
  await p.waitForTimeout(500);
}

export async function readDomText(limit = 6000): Promise<string> {
  const p = await getPage();
  if (overlayEnabled) await pulseOverlay("read-dom");
  const text = await p.evaluate(() => {
    const doc = (globalThis as any).document;
    const main = doc?.querySelector?.("main");
    const bodyText = (main?.textContent || doc?.body?.textContent || "").replace(/\s+/g, " ").trim();
    return bodyText;
  });
  return String(text).slice(0, limit);
}

export async function observeBrowserState(): Promise<string> {
  const p = await getPage();
  const snapshot = await p.evaluate(() => {
    const doc = (globalThis as any).document;
    const text = String(doc?.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000);
    const hash = Array.from(text).reduce((acc, ch) => ((acc * 31) + ch.charCodeAt(0)) >>> 0, 7);
    const modalSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      ".modal",
      ".popup",
      ".dialog",
      "[data-testid*='modal']",
      "[data-testid*='dialog']"
    ];
    const modalCount = modalSelectors.reduce((count, selector) => {
      try {
        return count + (doc?.querySelectorAll?.(selector)?.length || 0);
      } catch {
        return count;
      }
    }, 0);
    return {
      url: String((globalThis as any).location?.href || ""),
      title: String(doc?.title || ""),
      modalCount,
      bodyHash: hash
    };
  });

  const next = {
    ...snapshot,
    pageCount: context?.pages().length || 1
  };
  const notices: string[] = [];

  if (!lastPageSnapshot) {
    notices.push(`browser_state initialized at ${next.url || "(unknown url)"}`);
  } else {
    if (next.url !== lastPageSnapshot.url) notices.push(`url changed: ${next.url}`);
    if (next.title !== lastPageSnapshot.title) notices.push(`title changed: ${next.title || "(untitled)"}`);
    if (next.modalCount > lastPageSnapshot.modalCount) notices.push(`popup/modal appeared (${next.modalCount} visible)`);
    if (next.modalCount < lastPageSnapshot.modalCount) notices.push(`popup/modal count decreased (${next.modalCount} visible)`);
    if (next.pageCount > lastPageSnapshot.pageCount) notices.push(`new popup/page opened (${next.pageCount} total pages)`);
    if (next.pageCount < lastPageSnapshot.pageCount) notices.push(`popup/page closed (${next.pageCount} total pages)`);
    if (next.bodyHash !== lastPageSnapshot.bodyHash) notices.push("dom changed");
  }

  if (pendingDialogMessages.length) {
    notices.push(...pendingDialogMessages.splice(0).map((msg) => `dialog appeared: ${msg}`));
  }

  lastPageSnapshot = next;
  return notices.join("; ");
}

export async function setVisualOverlay(enabled: boolean): Promise<void> {
  overlayEnabled = enabled;
  const p = await getPage();
  if (enabled) {
    await ensureOverlay();
  } else {
    await p.evaluate(() => {
      const el = (globalThis as any).document?.getElementById("__forge_overlay");
      if (el?.parentNode) el.parentNode.removeChild(el);
    });
  }
}

export async function setAiCursorVisible(enabled: boolean): Promise<void> {
  aiCursorVisible = enabled;
  const p = await getPage();
  await ensureOverlay();
  if (enabled) {
    await ensureAiCursor();
  } else {
    await p.evaluate(() => {
      const el = (globalThis as any).document?.getElementById("__forge_ai_cursor");
      if (el?.parentNode) el.parentNode.removeChild(el);
    });
  }
}

async function ensureOverlay(): Promise<void> {
  const p = await getPage();
  await p.evaluate(() => {
    const doc = (globalThis as any).document;
    if (!doc) return;
    let el = doc.getElementById("__forge_overlay");
    if (!el) {
      el = doc.createElement("div");
      el.id = "__forge_overlay";
      el.setAttribute("style", [
        "position:fixed",
        "top:10px",
        "right:10px",
        "z-index:2147483647",
        "padding:6px 10px",
        "border:1px solid #3aa9ff",
        "background:rgba(18,42,88,0.65)",
        "color:#bfe4ff",
        "font:12px/1.2 monospace",
        "box-shadow:0 0 18px rgba(58,169,255,0.85)"
      ].join(";"));
      el.textContent = "FORGE AI ACTIVE";
      doc.body?.appendChild(el);
    }
  });
}

async function pulseOverlay(label: string): Promise<void> {
  const p = await getPage();
  await ensureOverlay();
  await p.evaluate((text) => {
    const doc = (globalThis as any).document;
    const el = doc?.getElementById("__forge_overlay");
    if (!el) return;
    el.textContent = `FORGE AI ACTIVE • ${text}`;
    el.style.boxShadow = "0 0 26px rgba(58,169,255,1)";
    setTimeout(() => {
      el.style.boxShadow = "0 0 18px rgba(58,169,255,0.85)";
    }, 180);
  }, label);
}

function attachContextObservers(ctx: BrowserContext): void {
  ctx.on("page", (newPage) => {
    newPage.on("dialog", (dialog) => {
      pendingDialogMessages.push(dialog.message().slice(0, 200));
    });
  });
  for (const existingPage of ctx.pages()) {
    existingPage.on("dialog", (dialog) => {
      pendingDialogMessages.push(dialog.message().slice(0, 200));
    });
  }
}

async function highlightSelector(selector: string): Promise<void> {
  const p = await getPage();
  await ensureOverlay();
  await p.evaluate((sel) => {
    const doc = (globalThis as any).document;
    const target = doc?.querySelector?.(sel);
    if (!target) return;
    const prev = (target as any).style.outline;
    (target as any).style.outline = "3px solid #3aa9ff";
    (target as any).style.boxShadow = "0 0 18px rgba(58,169,255,0.9)";
    setTimeout(() => {
      (target as any).style.outline = prev || "";
      (target as any).style.boxShadow = "";
    }, 700);
  }, selector);
}

async function ensureAiCursor(): Promise<void> {
  if (!aiCursorVisible) aiCursorVisible = true;
  const p = await getPage();
  await p.evaluate(
    ({ x, y }) => {
      const doc = (globalThis as any).document;
      if (!doc) return;
      let c = doc.getElementById("__forge_ai_cursor");
      if (!c) {
        c = doc.createElement("div");
        c.id = "__forge_ai_cursor";
        c.setAttribute("style", [
          "position:fixed",
          "top:0",
          "left:0",
          "width:18px",
          "height:18px",
          "margin-left:-9px",
          "margin-top:-9px",
          "border-radius:999px",
          "background:rgba(58,169,255,0.25)",
          "border:2px solid #3aa9ff",
          "box-shadow:0 0 18px rgba(58,169,255,0.95)",
          "z-index:2147483647",
          "pointer-events:none"
        ].join(";"));
        doc.body?.appendChild(c);
      }
      c.style.transform = `translate(${x}px, ${y}px)`;
    },
    { x: aiCursorX, y: aiCursorY }
  );
}

async function ensureActivePage(): Promise<void> {
  if (!context) {
    await launchBrowser(launchUserDataDir, launchExecutablePath);
    return;
  }

  try {
    if (!page || page.isClosed()) {
      page = context.pages()[0] ?? (await context.newPage());
    }
  } catch {
    context = null;
    page = null;
    await launchBrowser(launchUserDataDir, launchExecutablePath);
  }
}

async function getPage(): Promise<Page> {
  try {
    await ensureActivePage();
    if (!page) throw new Error("Failed to acquire browser page");
    return page;
  } catch (err) {
    const msg = String((err as Error)?.message || err || "");
    if (/Target page, context or browser has been closed/i.test(msg) || /has been closed/i.test(msg)) {
      context = null;
      page = null;
      await launchBrowser(launchUserDataDir, launchExecutablePath);
      if (page) return page;
    }
    throw err;
  }
}
