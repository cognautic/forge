import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

export async function runCommand(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
  const [program, ...args] = splitCommand(cmd);
  if (!program) {
    return { code: 1, output: "No command provided" };
  }
  return runCommandDirect(program, args, cwd);
}

export async function runCommandDirect(
  program: string,
  args: string[],
  cwd: string
): Promise<{ code: number; output: string }> {
  const safeCwd = resolveCwd(cwd);
  const env = buildEnvWithSbin(process.env);
  const candidates = resolveProgramCandidates(program);
  let lastErr: unknown;

  for (const bin of candidates) {
    try {
      const result = await runSpawn(bin, args, safeCwd, env);
      if (safeCwd !== cwd) {
        return { ...result, output: `[warn] cwd missing, used ${safeCwd}\n${result.output}` };
      }
      return result;
    } catch (err: any) {
      lastErr = err;
      if (err?.code !== "ENOENT") throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`Executable not found: ${program}`);
}

function resolveProgramCandidates(program: string): string[] {
  const out: string[] = [];
  if (program.includes("/")) {
    // If absolute/relative path is provided but missing, recover via basename lookup.
    if (existsSync(program)) out.push(program);
    const base = basename(program);
    if (base) out.push(base);
  } else {
    out.push(program);
  }
  const dirs = getSearchDirs();
  const lookup = out[0] && !out[0].includes("/") ? out[0] : basename(program);
  for (const dir of dirs) {
    const candidate = join(dir, lookup);
    if (existsSync(candidate)) out.push(candidate);
  }
  return [...new Set(out)];
}

function runSpawn(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env
    });

    let out = "";
    child.stdout.on("data", (d) => {
      const t = String(d);
      out += t;
      process.stdout.write(t);
    });
    child.stderr.on("data", (d) => {
      const t = String(d);
      out += t;
      process.stderr.write(t);
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output: out.slice(0, 12000) }));
  });
}

function buildEnvWithSbin(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dirs = getSearchDirs();
  const path = dirs.join(delimiter);
  return { ...env, PATH: path };
}

function resolveCwd(cwd: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  return process.cwd();
}

function getSearchDirs(): string[] {
  const fromEnv = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const common = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
  return [...new Set([...fromEnv, ...common])];
}

function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let esc = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }

  if (cur) out.push(cur);
  return out;
}
