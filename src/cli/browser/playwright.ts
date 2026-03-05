import { chromium, type BrowserContext, type Page } from "playwright";

let context: BrowserContext | null = null;
let page: Page | null = null;
let overlayEnabled = true;
let aiCursorX = 120;
let aiCursorY = 120;
let aiCursorVisible = false;
let launchUserDataDir = ".forge-data/browser";
let launchExecutablePath: string | undefined;

export async function launchBrowser(
  userDataDir = ".forge-data/browser",
  executablePath?: string
): Promise<void> {
  launchUserDataDir = userDataDir;
  launchExecutablePath = executablePath || undefined;

  if (!context) {
    context = await launchContextOrThrow(userDataDir, executablePath || undefined);
    page = context.pages()[0] ?? (await context.newPage());
    return;
  }

  try {
    if (!page || page.isClosed()) {
      page = context.pages()[0] ?? (await context.newPage());
    }
  } catch {
    context = await launchContextOrThrow(userDataDir, executablePath || undefined);
    page = context.pages()[0] ?? (await context.newPage());
  }
}

async function launchContextOrThrow(userDataDir: string, executablePath?: string): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath
    });
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
