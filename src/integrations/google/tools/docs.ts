import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

async function getClients(userId: string) {
  const auth = await ensureGoogleClient(userId, [...SCOPES.docs]);
  return {
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth })
  };
}

const ok = <T>(data: T): ToolExecutionResult<T> => ({ success: true, data });
const fail = (error: unknown): ToolExecutionResult => ({ success: false, error: error instanceof Error ? error.message : String(error) });

export const docsTools: ToolDefinition[] = [
  {
    name: "docs_create",
    description: "Create a Google Doc and optionally seed it with content.",
    product: "docs",
    scopes: [...SCOPES.docs],
    parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title"] },
    execute: async ({ title, content }, userId) => {
      try {
        return ok(await (async () => {
          const { docs } = await getClients(userId);
          const created = await docs.documents.create({ requestBody: { title: String(title) } });
          if (content) {
            await docs.documents.batchUpdate({
              documentId: String(created.data.documentId),
              requestBody: { requests: [{ insertText: { location: { index: 1 }, text: String(content) } }] }
            });
          }
          return created.data;
        })());
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "docs_read",
    description: "Read a Google Document.",
    product: "docs",
    scopes: [...SCOPES.docs],
    parameters: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] },
    execute: async ({ documentId }, userId) => {
      try {
        return ok(await (async () => {
          const { docs } = await getClients(userId);
          const res = await docs.documents.get({ documentId: String(documentId) });
          return res.data;
        })());
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "docs_append_text",
    description: "Append text to the end of a Google Document.",
    product: "docs",
    scopes: [...SCOPES.docs],
    parameters: { type: "object", properties: { documentId: { type: "string" }, text: { type: "string" } }, required: ["documentId", "text"] },
    execute: async ({ documentId, text }, userId) => {
      try {
        return ok(await (async () => {
          const { docs } = await getClients(userId);
          const current = await docs.documents.get({ documentId: String(documentId) });
          const index = current.data.body?.content?.reduce((max, item) => Math.max(max, item.endIndex || 1), 1) || 1;
          const res = await docs.documents.batchUpdate({
            documentId: String(documentId),
            requestBody: { requests: [{ insertText: { location: { index: Math.max(1, index - 1) }, text: String(text) } }] }
          });
          return res.data;
        })());
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "docs_replace_text",
    description: "Find and replace text across a Google Document.",
    product: "docs",
    scopes: [...SCOPES.docs],
    parameters: { type: "object", properties: { documentId: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["documentId", "find", "replace"] },
    execute: async ({ documentId, find, replace }, userId) => {
      try {
        return ok(await (async () => {
          const { docs } = await getClients(userId);
          const res = await docs.documents.batchUpdate({
            documentId: String(documentId),
            requestBody: { requests: [{ replaceAllText: { containsText: { text: String(find), matchCase: true }, replaceText: String(replace) } }] }
          });
          return res.data;
        })());
      } catch (error) {
        return fail(error);
      }
    }
  }
];
