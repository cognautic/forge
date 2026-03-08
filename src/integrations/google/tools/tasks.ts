import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

async function withTasks<T>(userId: string, run: (api: ReturnType<typeof google.tasks>) => Promise<T>): Promise<T> {
  const auth = await ensureGoogleClient(userId, [...SCOPES.tasks]);
  return await run(google.tasks({ version: "v1", auth }));
}

const ok = <T>(data: T): ToolExecutionResult<T> => ({ success: true, data });
const fail = (error: unknown): ToolExecutionResult => ({ success: false, error: error instanceof Error ? error.message : String(error) });

export const tasksTools: ToolDefinition[] = [
  {
    name: "tasks_list",
    description: "List tasks from a Google Tasks task list.",
    product: "tasks",
    scopes: [...SCOPES.tasks],
    parameters: { type: "object", properties: { taskListId: { type: "string" } } },
    execute: async ({ taskListId }, userId) => {
      try {
        return ok(await withTasks(userId, async (api) => {
          const listId = String(taskListId || "@default");
          const res = await api.tasks.list({ tasklist: listId });
          return res.data.items || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "tasks_create",
    description: "Create a Google Task.",
    product: "tasks",
    scopes: [...SCOPES.tasks],
    parameters: { type: "object", properties: { title: { type: "string" }, notes: { type: "string" }, due: { type: "string" }, taskListId: { type: "string" } }, required: ["title"] },
    execute: async ({ title, notes, due, taskListId }, userId) => {
      try {
        return ok(await withTasks(userId, async (api) => {
          const res = await api.tasks.insert({ tasklist: String(taskListId || "@default"), requestBody: { title: String(title), notes: notes ? String(notes) : undefined, due: due ? String(due) : undefined } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "tasks_complete",
    description: "Mark a Google Task as completed.",
    product: "tasks",
    scopes: [...SCOPES.tasks],
    parameters: { type: "object", properties: { taskId: { type: "string" }, taskListId: { type: "string" } }, required: ["taskId"] },
    execute: async ({ taskId, taskListId }, userId) => {
      try {
        return ok(await withTasks(userId, async (api) => {
          const res = await api.tasks.patch({ tasklist: String(taskListId || "@default"), task: String(taskId), requestBody: { status: "completed", completed: new Date().toISOString() } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "tasks_delete",
    description: "Delete a Google Task.",
    product: "tasks",
    scopes: [...SCOPES.tasks],
    parameters: { type: "object", properties: { taskId: { type: "string" }, taskListId: { type: "string" } }, required: ["taskId"] },
    execute: async ({ taskId, taskListId }, userId) => {
      try {
        return ok(await withTasks(userId, async (api) => {
          await api.tasks.delete({ tasklist: String(taskListId || "@default"), task: String(taskId) });
          return { deleted: true, taskId: String(taskId) };
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "tasks_list_tasklists",
    description: "List Google Tasks task lists.",
    product: "tasks",
    scopes: [...SCOPES.tasks],
    parameters: { type: "object", properties: {} },
    execute: async (_params, userId) => {
      try {
        return ok(await withTasks(userId, async (api) => {
          const res = await api.tasklists.list();
          return res.data.items || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  }
];
