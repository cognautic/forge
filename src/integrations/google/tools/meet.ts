import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

const ok = <T>(data: T): ToolExecutionResult<T> => ({ success: true, data });
const fail = (error: unknown): ToolExecutionResult => ({ success: false, error: error instanceof Error ? error.message : String(error) });

export const meetTools: ToolDefinition[] = [
  {
    name: "meet_create_meeting",
    description: "Create a Google Meet meeting by creating a Calendar event with conference data.",
    product: "meet",
    scopes: [...SCOPES.meet],
    parameters: { type: "object", properties: { summary: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, attendees: { type: "array", items: { type: "string" } } }, required: ["summary", "startTime", "endTime"] },
    execute: async ({ summary, startTime, endTime, attendees }, userId) => {
      try {
        const auth = await ensureGoogleClient(userId, [...SCOPES.meet]);
        const calendar = google.calendar({ version: "v3", auth });
        const res = await calendar.events.insert({
          calendarId: "primary",
          conferenceDataVersion: 1,
          requestBody: {
            summary: String(summary),
            start: { dateTime: String(startTime) },
            end: { dateTime: String(endTime) },
            attendees: Array.isArray(attendees) ? attendees.map((email) => ({ email: String(email) })) : undefined,
            conferenceData: {
              createRequest: {
                requestId: `forge-${Date.now()}`,
                conferenceSolutionKey: { type: "hangoutsMeet" }
              }
            }
          }
        });
        return ok(res.data);
      } catch (error) {
        return fail(error);
      }
    }
  }
];
