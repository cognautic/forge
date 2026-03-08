import { Buffer } from "node:buffer";
import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

async function withGmail<T>(userId: string, run: (api: ReturnType<typeof google.gmail>) => Promise<T>): Promise<T> {
  const auth = await ensureGoogleClient(userId, [...SCOPES.gmail]);
  return await run(google.gmail({ version: "v1", auth }));
}

function ok<T>(data: T): ToolExecutionResult<T> {
  return { success: true, data };
}

function fail(error: unknown): ToolExecutionResult {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

function toRawEmail(headers: Record<string, string>, body: string): string {
  const mime = `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

function getBody(payload: any): string {
  const direct = payload?.body?.data ? Buffer.from(payload.body.data, "base64").toString("utf8") : "";
  if (direct) return direct;
  const part = payload?.parts?.find((item: any) => item?.mimeType === "text/plain" || item?.mimeType === "text/html");
  if (part?.body?.data) return Buffer.from(part.body.data, "base64").toString("utf8");
  return "";
}

export const gmailTools: ToolDefinition[] = [
  {
    name: "gmail_list_emails",
    description: "List Gmail messages matching an optional query.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } } },
    execute: async ({ query, maxResults }, userId) => {
      try {
        return ok(await withGmail(userId, async (api) => {
          const res = await api.users.messages.list({ userId: "me", q: String(query || ""), maxResults: Number(maxResults || 10) });
          return res.data.messages || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "gmail_read_email",
    description: "Read a full Gmail message body and metadata by message id.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
    execute: async ({ messageId }, userId) => {
      try {
        return ok(await withGmail(userId, async (api) => {
          const res = await api.users.messages.get({ userId: "me", id: String(messageId), format: "full" });
          return { id: res.data.id, snippet: res.data.snippet, headers: res.data.payload?.headers || [], body: getBody(res.data.payload) };
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "gmail_send_email",
    description: "Send an email from the connected Gmail account.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, bcc: { type: "string" } },
      required: ["to", "subject", "body"]
    },
    execute: async ({ to, subject, body, cc, bcc }, userId) => {
      try {
        return ok(await withGmail(userId, async (api) => {
          const raw = toRawEmail({ To: String(to), Subject: String(subject), ...(cc ? { Cc: String(cc) } : {}), ...(bcc ? { Bcc: String(bcc) } : {}) }, String(body));
          const res = await api.users.messages.send({ userId: "me", requestBody: { raw } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "gmail_create_draft",
    description: "Create a Gmail draft.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
    execute: async ({ to, subject, body }, userId) => {
      try {
        return ok(await withGmail(userId, async (api) => {
          const raw = toRawEmail({ To: String(to), Subject: String(subject) }, String(body));
          const res = await api.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "gmail_reply_email",
    description: "Reply to an existing Gmail message thread.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: { type: "object", properties: { messageId: { type: "string" }, body: { type: "string" } }, required: ["messageId", "body"] },
    execute: async ({ messageId, body }, userId) => {
      try {
        return ok(await withGmail(userId, async (api) => {
          const message = await api.users.messages.get({ userId: "me", id: String(messageId), format: "metadata", metadataHeaders: ["Subject", "From", "Message-ID"] });
          const headers = message.data.payload?.headers || [];
          const subject = headers.find((h) => h.name === "Subject")?.value || "Re:";
          const to = headers.find((h) => h.name === "From")?.value || "";
          const inReplyTo = headers.find((h) => h.name === "Message-ID")?.value || "";
          const raw = toRawEmail({ To: to, Subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`, "In-Reply-To": inReplyTo, References: inReplyTo }, String(body));
          const res = await api.users.messages.send({ userId: "me", requestBody: { raw, threadId: message.data.threadId || undefined } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "gmail_search_emails",
    description: "Run an advanced Gmail search query.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async ({ query }, userId) => gmailTools[0].execute({ query, maxResults: 20 }, userId)
  },
  {
    name: "gmail_list_labels",
    description: "List Gmail labels in the connected account.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: { type: "object", properties: {} },
    execute: async (_params, userId) => {
      try {
        return ok(await withGmail(userId, async (api) => {
          const res = await api.users.labels.list({ userId: "me" });
          return res.data.labels || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "gmail_move_email",
    description: "Apply a Gmail label to a message or move it to a label.",
    product: "gmail",
    scopes: [...SCOPES.gmail],
    parameters: { type: "object", properties: { messageId: { type: "string" }, labelId: { type: "string" } }, required: ["messageId", "labelId"] },
    execute: async ({ messageId, labelId }, userId) => {
      try {
        return ok(await withGmail(userId, async (api) => {
          const res = await api.users.messages.modify({ userId: "me", id: String(messageId), requestBody: { addLabelIds: [String(labelId)] } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  }
];
