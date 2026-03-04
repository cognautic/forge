import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const keyPath = join(homedir(), ".config", "cognautic-forge", "keys.json");

async function readDb(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(keyPath, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function setSecret(name: string, value: string): Promise<void> {
  const db = await readDb();
  db[name] = value;
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, JSON.stringify(db, null, 2), { mode: 0o600 });
}

export async function getSecret(name: string): Promise<string | undefined> {
  const db = await readDb();
  return db[name];
}
