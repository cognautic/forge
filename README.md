# Cognautic Forge (Node CLI Co-Worker)

Cognautic Forge is a local-first, interactive Node CLI agent with:

- Multi-provider LLM support (user API keys)
- Tool-calling agent loop with auto-followup
- Browser automation (Playwright Chromium / custom executable)
- File and command execution tools
- System control tools (mouse/keyboard/screenshot/OCR)
- Stdio MCP server support
- Google Workspace tools via Forge auth
- Persistent collaborative workspace (objective, tasks, artifacts, timeline, roles)

## Install (npm)

Global install:

```bash
npm i -g @cognautic.space/forge
forge
```

Run without global install:

```bash
npx @cognautic.space/forge
```

## Local Development

```bash
bun install
bun run src/main.ts
```

This starts interactive mode.

Node path (no Bun runtime required):

```bash
npm install
npm run build:npm
node dist/main.js
```

## Build npm Package

```bash
npm run build:npm
npm pack
```

This generates `dist/main.js` and an npm tarball for publishing/install testing.
Do not use `bun build --compile` for Forge distribution because runtime modules like Playwright must remain external npm dependencies.

## Provider Support

- OpenAI
- NVIDIA NIM
- Google
- Anthropic
- OpenRouter
- Groq
- Cerebras
- Ollama
- Custom OpenAI-compatible endpoint

Model lists can be fetched from provider APIs and are used for command suggestions.

### NVIDIA NIM

Forge supports NVIDIA NIM through the `nim` provider.

Setup in chat:

```bash
/provider nim
/apikey nim <YOUR_NVIDIA_NIM_API_KEY>
/models refresh
/model <nim-model-id>
```

Setup with CLI commands:

```bash
forge provider set nim <nim-model-id>
forge provider key set nim <YOUR_NVIDIA_NIM_API_KEY>
forge provider models nim
```

Notes:
- Default NIM endpoint used by Forge: `https://integrate.api.nvidia.com/v1/chat/completions`
- Model list source: `https://integrate.api.nvidia.com/v1/models`

## Interactive Slash Commands

General:

- `/help`
- `/exit`
- `/clear`
- `/status`
- `/config` (guided setup)

Provider / model:

- `/providers`
- `/provider <openai|google|anthropic|openrouter|groq|cerebras|ollama|custom>`
- `/models`
- `/models refresh`
- `/model <model-id>`
- `/apikey <key>`
- `/apikey <provider> <key>`
- `/endpoint <url>` (custom / ollama endpoint)

Runtime / environment:

- `/mode <safe|yolo>`
- `/yolo [on|off|toggle]` (shortcut: `Ctrl+Y`)
- `/root <path>`
- `/browserpath </path/to/chrome-or-brave>`
- `/searchmode <safe|manual>`
- `/auth google`
- `/logout google`

Co-worker workspace:

- `/objective <text>`
- `/objective show`
- `/task add <title>`
- `/task list [status]`
- `/task approve <taskId>`
- `/task start <taskId>`
- `/task review <taskId>`
- `/task complete <taskId>`
- `/task archive <taskId>`
- `/artifact add <taskId> <type> <ref>`
- `/artifact list`
- `/timeline`
- `/roles show`
- `/roles set <architect|planner|executor|reviewer|memory_manager> <owner>`
- `/skill add <path/to/SKILL.md>`
- `/skill list`

Autocomplete / ghost suggestions:

- Commands
- Providers
- Model IDs (from fetched models)
- Task/role subcommands

## Workspace Persistence

Forge persists two layers:

1. Global app state:
   - `~/.config/cognautic-forge/state.json`
   - provider/model/keys/projectRoot/browserPath/onboarding/searchMode/executionMode/autoContinue

2. Project cowork workspace:
   - `<projectRoot>/.forge-data/cowork-workspace.json`
   - objective, task list, roles, artifacts, timeline history

Task lifecycle is enforced:

`proposed -> approved -> in_progress -> under_review -> completed -> archived`

Allowed rework path:

`under_review -> in_progress`

## Agent Behavior

The interactive AI turn uses a JSON tool-envelope protocol:

- Tool calls only, then `finish_response` for final output
- Auto-followup continuation until task completion or safety limit
- Workspace digest injected into model context each turn
- Structured coworker framing:
  - Architect -> Planner -> Executor -> Reviewer -> Memory Manager

## Implemented Tool Surface

Google Workspace:

- `google.gmail_list_emails`
- `google.gmail_read_email`
- `google.gmail_send_email`
- `google.gmail_create_draft`
- `google.gmail_reply_email`
- `google.gmail_search_emails`
- `google.gmail_list_labels`
- `google.gmail_move_email`
- `google.calendar_list_events`
- `google.calendar_create_event`
- `google.calendar_update_event`
- `google.calendar_delete_event`
- `google.calendar_get_event`
- `google.calendar_list_calendars`
- `google.calendar_find_free_slots`
- `google.drive_list_files`
- `google.drive_search_files`
- `google.drive_get_file`
- `google.drive_upload_file`
- `google.drive_create_folder`
- `google.drive_delete_file`
- `google.drive_move_file`
- `google.drive_share_file`
- `google.docs_create`
- `google.docs_read`
- `google.docs_append_text`
- `google.docs_replace_text`
- `google.sheets_create`
- `google.sheets_read_range`
- `google.sheets_write_range`
- `google.sheets_append_row`
- `google.sheets_get_all`
- `google.tasks_list`
- `google.tasks_create`
- `google.tasks_complete`
- `google.tasks_delete`
- `google.tasks_list_tasklists`
- `google.contacts_search`
- `google.contacts_get`
- `google.contacts_list`
- `google.contacts_create`
- `google.meet_create_meeting`

Browser:

- `browser.launch`
- `browser.goto`
- `browser.search` (Google)
- `browser.read_dom`
- `browser.scroll`
- `browser.extract`
- `browser.click`
- `browser.eval`
- `browser.overlay_on/off`
- `browser.cursor_show/hide/move/click/type`

System:

- `system.mouse_move`
- `system.mouse_click`
- `system.keyboard_type`
- `system.screen_capture`
- `system.screen_ocr`

Workspace / OS:

- `files.read`
- `files.write`
- `command.run`
- `system.exec`
- `exec.run`
- `exec.direct`
- `mcp.<server>.<tool>` for configured stdio MCP servers
- `plans.update`

Finalization:

- `finish_response`

## Non-Interactive CLI Commands

State / provider:

```bash
forge state show
forge state set-root /path/to/project
forge state set-browser /usr/sbin/brave
forge provider show
forge provider set openai gpt-4.1-mini
forge provider key set openai sk-...
forge provider models openai
forge mcp list
forge mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
forge mcp remove filesystem
forge auth google
forge logout google
```

## Google Login

Users do not need to add Google client id or Google client secret locally.
Forge uses the deployed Convex backend for Google OAuth, token exchange, logout, and refresh.

Login:

```bash
forge auth google
```

Or inside chat:

```text
/auth google
```

Logout:

```bash
forge logout google
```

Or inside chat:

```text
/logout google
```

After login, Google tools are available directly in chat and agent turns for:

- Gmail
- Calendar
- Drive
- Docs
- Sheets
- Tasks
- Contacts
- Meet

## MCP Servers

Forge supports stdio MCP servers configured in app state.

Examples:

```bash
forge mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
forge mcp list
```

Configured MCP tools are exposed to the agent as `mcp.<server>.<tool>`.

Chat:

```bash
forge chat "summarize this repository"
```

Workspace:

```bash
forge workspace show
forge workspace objective "Ship feature X with tests"
forge workspace task add "Draft implementation plan"
forge workspace task list
forge workspace task set <taskId> approved
```

## Notes

- Forge is local-first; you provide your own provider keys.
- Browser automation uses Playwright persistent context.
- Custom browser executable is supported via `/browserpath` or `state set-browser`.
- Execution modes:
  - `safe`: every tool action requires user confirmation.
  - `yolo`: all tool actions auto-execute with no confirmation prompts.
- The agent is instructed to use Google for search/research workflows.
- The agent prefers no-browser web tools first (`web.search`, `web.read`) and uses browser tools as fallback.
- Search safety modes:
  - `safe`: attempts Google search, detects captcha/challenge pages, then falls back to user-assisted flow.
  - `manual`: opens Google and asks user to perform search/clicks manually, then agent reads DOM and summarizes.
