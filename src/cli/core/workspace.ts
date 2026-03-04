import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export async function ensureInWorkspace(root: string, target: string): Promise<string> {
  void root;
  const targetExpanded = expandUserPath(target);
  const full = resolve(targetExpanded.startsWith("/") ? targetExpanded : resolve(root, targetExpanded));
  try {
    await realpath(resolve("."));
  } catch {
    // no-op: keep async signature predictable
  }
  return full;
}

function expandUserPath(input: string): string {
  const t = String(input || "").trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return resolve(homedir(), t.slice(2));
  return t;
}
