import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { configDir } from "./state";

const GLOBAL_SKILLS_DIR = join(configDir, "skills");

function sanitizeSkillName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "skill";
  const cleaned = trimmed
    .replace(/\.[^.]+$/, "") // drop extension
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "skill";
}

function inferSkillName(sourcePath: string): string {
  const base = basename(sourcePath);
  const lower = base.toLowerCase();
  if (lower === "skill.md" || lower === "skill.markdown") {
    // If user passes a conventional "SKILL.md", use parent dir name when possible.
    const parent = basename(dirname(sourcePath));
    return sanitizeSkillName(parent || "skill");
  }
  const withoutExt = base.slice(0, Math.max(0, base.length - extname(base).length));
  return sanitizeSkillName(withoutExt || base);
}

export function resolveSkillSourcePath(projectRoot: string, inputPath: string): string {
  let raw = inputPath.trim();
  if (!raw) return "";
  if (raw === "~") raw = homedir();
  else if (raw.startsWith("~/")) raw = join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
}

export async function installSkillFromFile(opts: {
  projectRoot: string;
  sourcePath: string;
}): Promise<{ name: string; destPath: string; bytes: number }> {
  const name = inferSkillName(opts.sourcePath);
  const destPath = join(GLOBAL_SKILLS_DIR, name, "SKILL.md");

  const content = await readFile(opts.sourcePath, "utf-8"); // read before doing anything else
  const normalized = content.replace(/\r\n/g, "\n");
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, normalized, "utf-8");

  return { name, destPath, bytes: Buffer.byteLength(normalized, "utf-8") };
}

async function readSkillDir(dir: string): Promise<Array<{ name: string; path: string; content: string }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skills: Array<{ name: string; path: string; content: string }> = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillName = ent.name;
      const mdPath = join(dir, skillName, "SKILL.md");
      try {
        const st = await stat(mdPath);
        if (!st.isFile()) continue;
        const content = await readFile(mdPath, "utf-8");
        skills.push({ name: skillName, path: mdPath, content });
      } catch {
        // ignore missing/invalid skill dir
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  } catch {
    return [];
  }
}

export async function listInstalledSkills(projectRoot: string): Promise<{
  global: Array<{ name: string; path: string }>;
}> {
  void projectRoot;
  const global = (await readSkillDir(GLOBAL_SKILLS_DIR)).map((s) => ({ name: s.name, path: s.path }));
  return { global };
}

export async function loadSkillsContext(projectRoot: string, opts?: { maxChars?: number }): Promise<string> {
  const maxChars = Math.max(10_000, Math.min(250_000, opts?.maxChars ?? 80_000));
  const global = await readSkillDir(GLOBAL_SKILLS_DIR);
  void projectRoot;

  if (!global.length) return "(none)";

  const chunks: string[] = [];
  const pushChunk = (s: string) => {
    if (!s) return;
    if (chunks.join("\n").length + s.length + 1 > maxChars) return;
    chunks.push(s);
  };

  if (global.length) {
    pushChunk("Global skills:");
    for (const sk of global) {
      pushChunk(`\n[${sk.name}] (${sk.path})\n${sk.content}`.trimEnd());
    }
  }

  const joined = chunks.join("\n");
  return joined.length ? joined : "(none)";
}
