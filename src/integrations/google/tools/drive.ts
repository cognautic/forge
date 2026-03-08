import { Readable } from "node:stream";
import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

async function withDrive<T>(userId: string, run: (api: ReturnType<typeof google.drive>) => Promise<T>): Promise<T> {
  const auth = await ensureGoogleClient(userId, [...SCOPES.drive]);
  return await run(google.drive({ version: "v3", auth }));
}

const ok = <T>(data: T): ToolExecutionResult<T> => ({ success: true, data });
const fail = (error: unknown): ToolExecutionResult => ({ success: false, error: error instanceof Error ? error.message : String(error) });

export const driveTools: ToolDefinition[] = [
  {
    name: "drive_list_files",
    description: "List files from Google Drive.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { query: { type: "string" }, folderId: { type: "string" }, maxResults: { type: "number" } } },
    execute: async ({ query, folderId, maxResults }, userId) => {
      try {
        return ok(await withDrive(userId, async (api) => {
          const q = [query ? String(query) : "", folderId ? `'${String(folderId)}' in parents` : ""].filter(Boolean).join(" and ");
          const res = await api.files.list({ q: q || undefined, pageSize: Number(maxResults || 20), fields: "files(id,name,mimeType,parents,webViewLink)" });
          return res.data.files || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "drive_search_files",
    description: "Search Google Drive files by query.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async ({ query }, userId) => driveTools[0].execute({ query, maxResults: 20 }, userId)
  },
  {
    name: "drive_get_file",
    description: "Get Google Drive file metadata and export links.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
    execute: async ({ fileId }, userId) => {
      try {
        return ok(await withDrive(userId, async (api) => {
          const res = await api.files.get({ fileId: String(fileId), fields: "*" });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "drive_upload_file",
    description: "Upload a text file to Google Drive.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, mimeType: { type: "string" }, folderId: { type: "string" } }, required: ["name", "content", "mimeType"] },
    execute: async ({ name, content, mimeType, folderId }, userId) => {
      try {
        return ok(await withDrive(userId, async (api) => {
          const res = await api.files.create({
            requestBody: {
              name: String(name),
              parents: folderId ? [String(folderId)] : undefined
            },
            media: {
              mimeType: String(mimeType),
              body: Readable.from([String(content)])
            },
            fields: "id,name,mimeType,webViewLink"
          });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "drive_create_folder",
    description: "Create a folder in Google Drive.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { name: { type: "string" }, parentId: { type: "string" } }, required: ["name"] },
    execute: async ({ name, parentId }, userId) => {
      try {
        return ok(await withDrive(userId, async (api) => {
          const res = await api.files.create({
            requestBody: { name: String(name), mimeType: "application/vnd.google-apps.folder", parents: parentId ? [String(parentId)] : undefined },
            fields: "id,name,parents"
          });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "drive_delete_file",
    description: "Delete a file from Google Drive.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
    execute: async ({ fileId }, userId) => {
      try {
        return ok(await withDrive(userId, async (api) => {
          await api.files.delete({ fileId: String(fileId) });
          return { deleted: true, fileId: String(fileId) };
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "drive_move_file",
    description: "Move a file to a new Google Drive folder.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { fileId: { type: "string" }, newParentId: { type: "string" } }, required: ["fileId", "newParentId"] },
    execute: async ({ fileId, newParentId }, userId) => {
      try {
        return ok(await withDrive(userId, async (api) => {
          const current = await api.files.get({ fileId: String(fileId), fields: "parents" });
          const previous = (current.data.parents || []).join(",");
          const res = await api.files.update({ fileId: String(fileId), addParents: String(newParentId), removeParents: previous, fields: "id,name,parents" });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "drive_share_file",
    description: "Share a Google Drive file with a user.",
    product: "drive",
    scopes: [...SCOPES.drive],
    parameters: { type: "object", properties: { fileId: { type: "string" }, email: { type: "string" }, role: { type: "string" } }, required: ["fileId", "email", "role"] },
    execute: async ({ fileId, email, role }, userId) => {
      try {
        return ok(await withDrive(userId, async (api) => {
          const res = await api.permissions.create({ fileId: String(fileId), requestBody: { type: "user", emailAddress: String(email), role: String(role) } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  }
];
