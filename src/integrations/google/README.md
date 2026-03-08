# Google Workspace Integration for Forge

This module adds Google Workspace tools to Cognautic Forge using OAuth2 and the `googleapis` package.

## Google Cloud Setup

1. Create a Google Cloud project at https://console.cloud.google.com/.
2. Enable these APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Tasks API
   - People API
3. Configure the OAuth consent screen.
4. Create an OAuth Client ID of type `Desktop app` or `Web application`.
5. Add this authorized redirect URI:
   - `http://localhost:3747/auth/google/callback`
6. Store the client id and client secret in your Convex backend environment.

## Login And Logout

Users log in through Forge:

- `forge auth google`
- `/auth google`

Users log out through Forge:

- `forge logout google`
- `/logout google`

Forge uses the deployed Convex backend for Google auth, code exchange, logout, and refresh. Google client secrets are not needed in the local CLI environment.

## Available Google Tools

- Gmail: list, read, send, draft, reply, search, labels, move/label
- Calendar: list events, create, update, delete, get, list calendars, free/busy
- Drive: list, search, get, upload, create folder, delete, move, share
- Docs: create, read, append text, replace text
- Sheets: create, read range, write range, append row, get all
- Tasks: list, create, complete, delete, list task lists
- Contacts: search, get, list, create
- Meet: create meeting via Calendar conference data

## Token Storage

Forge stores encrypted Google tokens in:

```text
.forge/google-tokens/{userId}.json
```

Tokens are encrypted with AES-256-GCM using a key derived from `FORGE_ENCRYPTION_KEY` when provided, or a machine-local fallback key when it is not.

## Adding the Integration to Forge

Import the integration:

```ts
import { GoogleIntegration } from "./src/integrations/google";

const googleIntegration = new GoogleIntegration();
```

Connect a user:

```ts
await googleIntegration.connect("alice", ["gmail", "calendar", "drive"]);
```

Disconnect a user:

```ts
await googleIntegration.disconnect("alice");
```

Expose tools to an LLM:

```ts
const tools = googleIntegration.getTools(["gmail", "calendar", "drive"]);
```

Run a tool:

```ts
const result = await googleIntegration.run(
  "calendar_create_event",
  {
    summary: "Project Sync",
    start: "2026-03-09T10:00:00+05:30",
    end: "2026-03-09T10:30:00+05:30"
  },
  "alice"
);
```

## Example Agent Usage

Read email:

```ts
await googleIntegration.run("gmail_list_emails", { query: "is:unread", maxResults: 5 }, "alice");
```

Create a calendar event:

```ts
await googleIntegration.run(
  "calendar_create_event",
  {
    summary: "Team Sync",
    start: "2026-03-10T15:00:00Z",
    end: "2026-03-10T15:30:00Z",
    attendees: ["teammate@example.com"]
  },
  "alice"
);
```

Save a file to Drive:

```ts
await googleIntegration.run(
  "drive_upload_file",
  {
    name: "notes.txt",
    content: "Weekly notes",
    mimeType: "text/plain"
  },
  "alice"
);
```
