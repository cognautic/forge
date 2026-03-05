import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  CoworkRole,
  CoworkWorkspace,
  TaskStatus,
  WorkspaceArtifact,
  WorkspaceTask
} from "../types";

const WORKSPACE_FILE = ".forge-data/cowork-workspace.json";

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultWorkspace(projectRoot: string): CoworkWorkspace {
  return {
    version: 1,
    projectRoot,
    objective: { text: "", updatedAt: nowIso() },
    roles: {
      architect: "system",
      planner: "system",
      executor: "system",
      reviewer: "system",
      memory_manager: "system"
    },
    tasks: [],
    artifacts: [],
    history: [],
    memory: {
      summary: "",
      lastIntent: "",
      recentTurns: []
    }
  };
}

export function workspacePath(projectRoot: string): string {
  return resolve(projectRoot, WORKSPACE_FILE);
}

export async function loadWorkspace(projectRoot: string): Promise<CoworkWorkspace> {
  const path = workspacePath(projectRoot);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CoworkWorkspace>;
    return {
      ...defaultWorkspace(projectRoot),
      ...parsed,
      projectRoot,
      roles: { ...defaultWorkspace(projectRoot).roles, ...(parsed.roles || {}) },
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    return defaultWorkspace(projectRoot);
  }
}

export async function saveWorkspace(ws: CoworkWorkspace): Promise<void> {
  const path = workspacePath(ws.projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ws, null, 2), "utf-8");
}

function pushEvent(ws: CoworkWorkspace, kind: CoworkWorkspace["history"][number]["kind"], detail: string): CoworkWorkspace {
  const next = {
    ...ws,
    history: [
      ...ws.history,
      {
        id: newId("evt"),
        ts: nowIso(),
        kind,
        detail
      }
    ]
  };
  if (next.history.length > 600) next.history = next.history.slice(-600);
  return next;
}

export function setObjective(ws: CoworkWorkspace, text: string): CoworkWorkspace {
  const next = {
    ...ws,
    objective: { text: text.trim(), updatedAt: nowIso() }
  };
  return pushEvent(next, "objective", `objective updated`);
}

export function addTask(ws: CoworkWorkspace, title: string, ownerRole: CoworkRole = "planner"): CoworkWorkspace {
  const t = nowIso();
  const task: WorkspaceTask = {
    id: newId("task"),
    title: title.trim(),
    status: "proposed",
    ownerRole,
    createdAt: t,
    updatedAt: t
  };
  return pushEvent({ ...ws, tasks: [...ws.tasks, task] }, "task", `task added ${task.id}`);
}

export function addArtifact(ws: CoworkWorkspace, taskId: string, type: string, ref: string): CoworkWorkspace {
  const task = ws.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const artifact: WorkspaceArtifact = {
    id: newId("art"),
    taskId,
    type: type.trim() || "note",
    ref: ref.trim(),
    createdAt: nowIso()
  };
  return pushEvent({ ...ws, artifacts: [...ws.artifacts, artifact] }, "artifact", `artifact added ${artifact.id} for ${taskId}`);
}

function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  if (from === "proposed") return to === "approved" || to === "archived";
  if (from === "approved") return to === "in_progress" || to === "archived";
  if (from === "in_progress") return to === "under_review" || to === "archived";
  if (from === "under_review") return to === "completed" || to === "in_progress" || to === "archived";
  if (from === "completed") return to === "archived";
  return false;
}

export function setTaskStatus(ws: CoworkWorkspace, taskId: string, status: TaskStatus, notes?: string): CoworkWorkspace {
  const idx = ws.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) throw new Error(`task not found: ${taskId}`);
  const current = ws.tasks[idx];
  if (!canTransition(current.status, status)) {
    throw new Error(`invalid transition ${current.status} -> ${status}`);
  }
  const updated: WorkspaceTask = {
    ...current,
    status,
    notes: notes?.trim() || current.notes,
    updatedAt: nowIso()
  };
  const tasks = ws.tasks.slice();
  tasks[idx] = updated;
  return pushEvent({ ...ws, tasks }, "task", `task ${taskId} => ${status}`);
}

export function setRoleOwner(ws: CoworkWorkspace, role: CoworkRole, owner: string): CoworkWorkspace {
  return pushEvent(
    { ...ws, roles: { ...ws.roles, [role]: owner.trim() || "system" } },
    "objective",
    `role ${role} => ${owner.trim() || "system"}`
  );
}

export function workspaceDigest(ws: CoworkWorkspace): string {
  const topTasks = ws.tasks.slice(-12).map((t) => `${t.id} [${t.status}] (${t.ownerRole}) ${t.title}`);
  const recentEvents = ws.history.slice(-8).map((e) => `${e.ts} ${e.kind}: ${e.detail}`);
  return [
    `Workspace objective: ${ws.objective.text || "(unset)"}`,
    `Roles: ${Object.entries(ws.roles)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
    `Tasks (${ws.tasks.length}):`,
    ...(topTasks.length ? topTasks : ["(none)"]),
    `Artifacts: ${ws.artifacts.length}`,
    `Memory summary: ${ws.memory.summary || "(empty)"}`,
    `Last intent: ${ws.memory.lastIntent || "(none)"}`,
    "Recent turns:",
    ...(ws.memory.recentTurns.length
      ? ws.memory.recentTurns.slice(-4).map((t) => `U: ${trimForDigest(t.user)} | A: ${trimForDigest(t.ai)}`)
      : ["(none)"]),
    "Recent history:",
    ...(recentEvents.length ? recentEvents : ["(none)"])
  ].join("\n");
}

export function rememberTurn(ws: CoworkWorkspace, user: string, ai: string): CoworkWorkspace {
  const turn = {
    ts: nowIso(),
    user: user.trim(),
    ai: ai.trim()
  };
  const recentTurns = [...ws.memory.recentTurns, turn].slice(-16);
  const summary = buildMemorySummary(ws.memory.summary, turn.user, turn.ai);
  const next: CoworkWorkspace = {
    ...ws,
    memory: {
      summary,
      lastIntent: detectIntent(turn.user),
      recentTurns
    }
  };
  return pushEvent(next, "agent", "memory updated");
}

export function memoryDigest(ws: CoworkWorkspace): string {
  return [
    `Summary: ${ws.memory.summary || "(empty)"}`,
    `Last intent: ${ws.memory.lastIntent || "(none)"}`,
    "Recent turns:",
    ...(ws.memory.recentTurns.length
      ? ws.memory.recentTurns.slice(-6).map((t) => `- ${trimForDigest(t.user)} => ${trimForDigest(t.ai)}`)
      : ["(none)"])
  ].join("\n");
}

function buildMemorySummary(prev: string, user: string, ai: string): string {
  const entry = `User wanted: ${trimForDigest(user)} | AI did: ${trimForDigest(ai)}`;
  const combined = prev ? `${prev} || ${entry}` : entry;
  return combined.length > 900 ? combined.slice(combined.length - 900) : combined;
}

function detectIntent(user: string): string {
  const u = user.toLowerCase();
  if (/\b(search|research|find|look up|google)\b/.test(u)) return "research";
  if (/\b(write|create|edit|change|fix|refactor)\b/.test(u)) return "code_change";
  if (/\b(run|execute|command|terminal)\b/.test(u)) return "command_execution";
  if (/\b(browser|open|navigate|click|scroll)\b/.test(u)) return "browser_automation";
  if (/\b(config|provider|model|apikey)\b/.test(u)) return "configuration";
  return "general";
}

function trimForDigest(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (!one) return "(empty)";
  return one.length > 120 ? `${one.slice(0, 120)}...` : one;
}
