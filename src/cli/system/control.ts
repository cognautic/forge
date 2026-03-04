import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

async function runBin(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

export async function systemMouseMove(x: number, y: number): Promise<string> {
  await runBin("xdotool", ["mousemove", String(Math.floor(x)), String(Math.floor(y))]);
  return `mouse moved to ${Math.floor(x)},${Math.floor(y)}`;
}

export async function systemMouseClick(button: "left" | "right" | "middle" = "left"): Promise<string> {
  const map = { left: "1", middle: "2", right: "3" } as const;
  await runBin("xdotool", ["click", map[button]]);
  return `mouse clicked ${button}`;
}

export async function systemKeyboardType(text: string): Promise<string> {
  await runBin("xdotool", ["type", "--delay", "1", text]);
  return `typed ${text.length} chars`;
}

export async function systemScreenshot(outputDir = ".forge-data/screens"): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const filename = `screen-${Date.now()}.png`;
  const path = join(outputDir, filename);

  try {
    await runBin("import", ["-window", "root", path]);
    return path;
  } catch {
    await runBin("scrot", [path]);
    return path;
  }
}

export async function systemOcr(imagePath: string): Promise<string> {
  const text = await runBin("tesseract", [imagePath, "stdout"]);
  return text.slice(0, 12000);
}
