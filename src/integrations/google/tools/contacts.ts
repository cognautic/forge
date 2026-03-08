import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

async function withPeople<T>(userId: string, run: (api: ReturnType<typeof google.people>) => Promise<T>): Promise<T> {
  const auth = await ensureGoogleClient(userId, [...SCOPES.contacts]);
  return await run(google.people({ version: "v1", auth }));
}

const ok = <T>(data: T): ToolExecutionResult<T> => ({ success: true, data });
const fail = (error: unknown): ToolExecutionResult => ({ success: false, error: error instanceof Error ? error.message : String(error) });

export const contactsTools: ToolDefinition[] = [
  {
    name: "contacts_search",
    description: "Search Google Contacts by text query.",
    product: "contacts",
    scopes: [...SCOPES.contacts],
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async ({ query }, userId) => {
      try {
        return ok(await withPeople(userId, async (api) => {
          const res = await api.people.searchContacts({ query: String(query), readMask: "names,emailAddresses,phoneNumbers" });
          return res.data.results || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "contacts_get",
    description: "Get a Google contact by resource name.",
    product: "contacts",
    scopes: [...SCOPES.contacts],
    parameters: { type: "object", properties: { resourceName: { type: "string" } }, required: ["resourceName"] },
    execute: async ({ resourceName }, userId) => {
      try {
        return ok(await withPeople(userId, async (api) => {
          const res = await api.people.get({ resourceName: String(resourceName), personFields: "names,emailAddresses,phoneNumbers" });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "contacts_list",
    description: "List Google Contacts connections.",
    product: "contacts",
    scopes: [...SCOPES.contacts],
    parameters: { type: "object", properties: { maxResults: { type: "number" } } },
    execute: async ({ maxResults }, userId) => {
      try {
        return ok(await withPeople(userId, async (api) => {
          const res = await api.people.connections.list({ resourceName: "people/me", personFields: "names,emailAddresses,phoneNumbers", pageSize: Number(maxResults || 50) });
          return res.data.connections || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "contacts_create",
    description: "Create a Google Contact.",
    product: "contacts",
    scopes: [...SCOPES.contacts],
    parameters: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } }, required: ["name", "email"] },
    execute: async ({ name, email, phone }, userId) => {
      try {
        return ok(await withPeople(userId, async (api) => {
          const res = await api.people.createContact({
            requestBody: {
              names: [{ displayName: String(name), givenName: String(name) }],
              emailAddresses: [{ value: String(email) }],
              phoneNumbers: phone ? [{ value: String(phone) }] : undefined
            }
          });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  }
];
