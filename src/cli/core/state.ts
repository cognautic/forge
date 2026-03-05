import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ForgeState } from "../types";

const defaultState: ForgeState = {
  projectRoot: process.cwd(),
  autoApprove: false,
  autoContinueMax: 20,
  executionMode: "safe",
  onboardingComplete: false,
  searchMode: "safe",
  provider: {
    provider: "openai",
    model: "gpt-4.1-mini"
  },
  apiKeys: {}
};

export const statePath = join(homedir(), ".config", "cognautic-forge", "state.json");
export const configDir = dirname(statePath);

export async function loadState(): Promise<ForgeState> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ForgeState>;
    return {
      ...defaultState,
      ...parsed,
      executionMode: parsed.executionMode === "yolo" ? "yolo" : "safe",
      autoContinueMax:
        typeof parsed.autoContinueMax === "number" && Number.isFinite(parsed.autoContinueMax)
          ? Math.min(120, Math.max(1, Math.floor(parsed.autoContinueMax)))
          : 20,
      searchMode: parsed.searchMode === "manual" ? "manual" : "safe",
      provider: {
        ...defaultState.provider,
        ...(parsed.provider || {})
      },
      apiKeys: {
        ...defaultState.apiKeys,
        ...(parsed.apiKeys || {})
      }
    };
  } catch {
    return defaultState;
  }
}

export async function saveState(state: ForgeState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function resetForgeState(): Promise<void> {
  await rm(configDir, { recursive: true, force: true });
}
