import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ensureInWorkspace } from "./workspace";

export async function listFiles(root: string, limit = 500): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full));
      }
    }
  }

  await walk(root);
  return out;
}

export async function readWorkspaceFile(root: string, path: string): Promise<string> {
  const full = await ensureInWorkspace(root, path);
  return readFile(full, "utf8");
}

export async function writeWorkspaceFile(root: string, path: string, content: string): Promise<void> {
  const full = await ensureInWorkspace(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

export async function statWorkspaceFile(root: string, path: string): Promise<string> {
  const full = await ensureInWorkspace(root, path);
  const s = await stat(full);
  return `${s.isDirectory() ? "dir" : "file"} ${s.size} bytes`;
}
