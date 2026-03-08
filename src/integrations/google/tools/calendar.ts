import { google } from "googleapis";
import { ensureGoogleClient } from "../auth/oauth";
import { SCOPES } from "../auth/scopes";
import type { ToolDefinition, ToolExecutionResult } from "../registry";

async function withCalendar<T>(userId: string, run: (api: ReturnType<typeof google.calendar>) => Promise<T>): Promise<T> {
  const auth = await ensureGoogleClient(userId, [...SCOPES.calendar]);
  return await run(google.calendar({ version: "v3", auth }));
}

const ok = <T>(data: T): ToolExecutionResult<T> => ({ success: true, data });
const fail = (error: unknown): ToolExecutionResult => ({ success: false, error: error instanceof Error ? error.message : String(error) });

type EventDateTimeInput =
  | string
  | {
      dateTime?: string;
      date?: string;
      timeZone?: string;
    };

function normalizeEventDateTime(value: EventDateTimeInput): { dateTime?: string; date?: string; timeZone?: string } {
  if (typeof value === "string") {
    return { dateTime: value };
  }
  if (value && typeof value === "object") {
    return {
      dateTime: value.dateTime ? String(value.dateTime) : undefined,
      date: value.date ? String(value.date) : undefined,
      timeZone: value.timeZone ? String(value.timeZone) : undefined
    };
  }
  return {};
}

export const calendarTools: ToolDefinition[] = [
  {
    name: "calendar_list_events",
    description: "List events from a Google Calendar.",
    product: "calendar",
    scopes: [...SCOPES.calendar],
    parameters: { type: "object", properties: { calendarId: { type: "string" }, timeMin: { type: "string" }, timeMax: { type: "string" }, maxResults: { type: "number" } } },
    execute: async ({ calendarId, timeMin, timeMax, maxResults }, userId) => {
      try {
        return ok(await withCalendar(userId, async (api) => {
          const res = await api.events.list({
            calendarId: String(calendarId || "primary"),
            timeMin: timeMin ? String(timeMin) : undefined,
            timeMax: timeMax ? String(timeMax) : undefined,
            maxResults: Number(maxResults || 10),
            singleEvents: true,
            orderBy: "startTime"
          });
          return res.data.items || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "calendar_create_event",
    description: "Create a Google Calendar event.",
    product: "calendar",
    scopes: [...SCOPES.calendar],
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        summary: { type: "string" },
        start: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                dateTime: { type: "string" },
                date: { type: "string" },
                timeZone: { type: "string" }
              }
            }
          ]
        },
        end: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                dateTime: { type: "string" },
                date: { type: "string" },
                timeZone: { type: "string" }
              }
            }
          ]
        },
        description: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        location: { type: "string" }
      },
      required: ["summary", "start", "end"]
    },
    execute: async ({ calendarId, summary, start, end, description, attendees, location }, userId) => {
      try {
        return ok(await withCalendar(userId, async (api) => {
          const normalizedStart = normalizeEventDateTime(start as EventDateTimeInput);
          const normalizedEnd = normalizeEventDateTime(end as EventDateTimeInput);
          if (!normalizedStart.dateTime && !normalizedStart.date) {
            throw new Error("calendar_create_event requires start as a datetime string or { dateTime/date } object");
          }
          if (!normalizedEnd.dateTime && !normalizedEnd.date) {
            throw new Error("calendar_create_event requires end as a datetime string or { dateTime/date } object");
          }
          const res = await api.events.insert({
            calendarId: String(calendarId || "primary"),
            requestBody: {
              summary: String(summary),
              description: description ? String(description) : undefined,
              location: location ? String(location) : undefined,
              start: normalizedStart,
              end: normalizedEnd,
              attendees: Array.isArray(attendees) ? attendees.map((email) => ({ email: String(email) })) : undefined
            }
          });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "calendar_update_event",
    description: "Update a Google Calendar event with partial fields.",
    product: "calendar",
    scopes: [...SCOPES.calendar],
    parameters: { type: "object", properties: { eventId: { type: "string" }, updates: { type: "object" }, calendarId: { type: "string" } }, required: ["eventId", "updates"] },
    execute: async ({ eventId, updates, calendarId }, userId) => {
      try {
        return ok(await withCalendar(userId, async (api) => {
          const res = await api.events.patch({ calendarId: String(calendarId || "primary"), eventId: String(eventId), requestBody: (updates || {}) as any });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "calendar_delete_event",
    description: "Delete a Google Calendar event.",
    product: "calendar",
    scopes: [...SCOPES.calendar],
    parameters: { type: "object", properties: { eventId: { type: "string" }, calendarId: { type: "string" } }, required: ["eventId"] },
    execute: async ({ eventId, calendarId }, userId) => {
      try {
        return ok(await withCalendar(userId, async (api) => {
          await api.events.delete({ calendarId: String(calendarId || "primary"), eventId: String(eventId) });
          return { deleted: true, eventId: String(eventId) };
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "calendar_get_event",
    description: "Fetch a Google Calendar event by id.",
    product: "calendar",
    scopes: [...SCOPES.calendar],
    parameters: { type: "object", properties: { eventId: { type: "string" }, calendarId: { type: "string" } }, required: ["eventId"] },
    execute: async ({ eventId, calendarId }, userId) => {
      try {
        return ok(await withCalendar(userId, async (api) => {
          const res = await api.events.get({ calendarId: String(calendarId || "primary"), eventId: String(eventId) });
          return res.data;
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "calendar_list_calendars",
    description: "List calendars available to the connected user.",
    product: "calendar",
    scopes: [...SCOPES.calendar],
    parameters: { type: "object", properties: {} },
    execute: async (_params, userId) => {
      try {
        return ok(await withCalendar(userId, async (api) => {
          const res = await api.calendarList.list();
          return res.data.items || [];
        }));
      } catch (error) {
        return fail(error);
      }
    }
  },
  {
    name: "calendar_find_free_slots",
    description: "Find free time windows for attendees using the Google Calendar freebusy API.",
    product: "calendar",
    scopes: [...SCOPES.calendar],
    parameters: { type: "object", properties: { attendees: { type: "array", items: { type: "string" } }, duration: { type: "number" }, timeRange: { type: "object" } }, required: ["attendees", "duration", "timeRange"] },
    execute: async ({ attendees, duration, timeRange }, userId) => {
      try {
        return ok(await withCalendar(userId, async (api) => {
          const range = (timeRange || {}) as { start?: string; end?: string };
          const res = await api.freebusy.query({
            requestBody: {
              timeMin: String(range.start),
              timeMax: String(range.end),
              items: (Array.isArray(attendees) ? attendees : []).map((email) => ({ id: String(email) }))
            }
          });
          return { durationMinutes: Number(duration), calendars: res.data.calendars || {} };
        }));
      } catch (error) {
        return fail(error);
      }
    }
  }
];
