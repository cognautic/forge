import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

async function withSheets<T>(userId: string, run: (api: ReturnType<typeof google.sheets>) => Promise<T>): Promise<T> {
  const auth = await ensureGoogleClient(userId, [...SCOPES.sheets]);
  return await run(google.sheets({ version: "v4", auth }));
}

const ok = <T>(data: T): ToolExecutionResult<T> => ({ success: true, data });
const fail = (error: unknown): ToolExecutionResult => ({ success: false, error: error instanceof Error ? error.message : String(error) });

export const sheetsTools: ToolDefinition[] = [
  {
    name: "sheets_create",
    description: "Create a Google Spreadsheet.",
    product: "sheets",
    scopes: [...SCOPES.sheets],
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    execute: async ({ title }, userId) => {
      try {
        return ok(await withSheets(userId, async (api) => {
          const res = await api.spreadsheets.create({ requestBody: { properties: { title: String(title) } } });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "sheets_read_range",
    description: "Read a range from a Google Sheet.",
    product: "sheets",
    scopes: [...SCOPES.sheets],
    parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, range: { type: "string" } }, required: ["spreadsheetId", "range"] },
    execute: async ({ spreadsheetId, range }, userId) => {
      try {
        return ok(await withSheets(userId, async (api) => {
          const res = await api.spreadsheets.values.get({ spreadsheetId: String(spreadsheetId), range: String(range) });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "sheets_write_range",
    description: "Write values into a range in Google Sheets.",
    product: "sheets",
    scopes: [...SCOPES.sheets],
    parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, range: { type: "string" }, values: { type: "array", items: { type: "array", items: {} } } }, required: ["spreadsheetId", "range", "values"] },
    execute: async ({ spreadsheetId, range, values }, userId) => {
      try {
        return ok(await withSheets(userId, async (api) => {
          const res = await api.spreadsheets.values.update({
            spreadsheetId: String(spreadsheetId),
            range: String(range),
            valueInputOption: "USER_ENTERED",
            requestBody: { values: Array.isArray(values) ? values : [] }
          });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "sheets_append_row",
    description: "Append a row to a Google Sheet tab.",
    product: "sheets",
    scopes: [...SCOPES.sheets],
    parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, sheetName: { type: "string" }, values: { type: "array", items: {} } }, required: ["spreadsheetId", "sheetName", "values"] },
    execute: async ({ spreadsheetId, sheetName, values }, userId) => {
      try {
        return ok(await withSheets(userId, async (api) => {
          const res = await api.spreadsheets.values.append({
            spreadsheetId: String(spreadsheetId),
            range: `${String(sheetName)}!A:Z`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [Array.isArray(values) ? values : []] }
          });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "sheets_get_all",
    description: "Read spreadsheet metadata and all sheets.",
    product: "sheets",
    scopes: [...SCOPES.sheets],
    parameters: { type: "object", properties: { spreadsheetId: { type: "string" } }, required: ["spreadsheetId"] },
    execute: async ({ spreadsheetId }, userId) => {
      try {
        return ok(await withSheets(userId, async (api) => {
          const res = await api.spreadsheets.get({ spreadsheetId: String(spreadsheetId), includeGridData: false });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  }
];
