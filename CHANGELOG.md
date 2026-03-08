# Changelog

## 0.0.7 - 2026-03-08
- Added full Google Workspace integration:
  - Gmail, Calendar, Drive, Docs, Sheets, Tasks, Contacts, and Meet tools
  - OpenAI-function-style Google tool registry wired into Forge agent execution as `google.*`
- Added Google auth/logout flows:
  - `forge auth google`
  - `forge logout google`
  - `/auth google`
  - `/logout google`
- Added server-backed Google OAuth with Convex:
  - Convex dev and prod backend scaffolds
  - production deploy wiring for Google auth, token exchange, logout, and refresh
  - local Forge no longer needs `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET`
- Improved Google Calendar event creation:
  - accepts both plain datetime strings and `{ dateTime/date, timeZone }` objects
  - respects `calendarId`
- Updated docs:
  - Forge README
  - Google integration README
  - Convex README
  - website Forge docs
- Improved chat UX:
  - restored spinner loader below `ai>` instead of inline `ai> thinking...`
  - added current system date/time to the agent prompt
  - updated agent policy to prefer direct API/tool paths over browser automation for Google/API-capable tasks

## 0.0.6 - 2026-03-06
- Added startup npm registry update check with update-available banner in interactive chat.
- Added visible planning workflow:
  - new `plans.update` tool
  - live plan output with `pending`, `in_progress`, `completed`
  - completed steps rendered in grey
- Fixed prompt cursor rendering while using left/right arrow with live suggestions.
- Updated docs for NVIDIA NIM provider setup and usage in `README`.
- Synced CLI help/docs with current slash commands (removed stale `/autocontinue` mention).

## 0.0.5 - 2026-03-06
- Added visible planning support in chat:
  - new `plans.update` tool for structured step tracking
  - live plan rendering in CLI with statuses (`pending`, `in_progress`, `completed`)
  - completed plan steps are greyed out
- Improved agent planning behavior:
  - system guidance now instructs plan-first execution for non-trivial tasks
  - plan updates can be emitted during execution before `finish_response`
- Fixed prompt cursor rendering bug with live suggestions:
  - left/right arrow cursor movement now renders at the correct visual position

## 0.0.4 - 2026-03-05
- Improved no-browser web search reliability:
  - `web.search` now uses DuckDuckGo free API first, then falls back to both HTML and lite result pages.
  - Expanded DuckDuckGo result parsing patterns to capture more result link formats.
- Removed AI turn safety cap (no max-step limit); turns now continue until completion or explicit abort.
- Removed auto-continue configuration from interactive chat UX:
  - removed `/autocontinue` command
  - removed auto-continue from config wizard, status header, help, and autocomplete

## 0.0.3 - 2026-03-05
- Added no-browser web tools:
  - `web.search` (DuckDuckGo free API with HTML fallback)
  - `web.read` (fetch + text extraction from URLs)
- Added Cognautic-specific screenshot tool:
  - `cognautic.screen_share`
- Improved browser resilience:
  - browser tool calls retry after browser/context closed errors
  - false AI-stop triggers from raw escape sequences reduced
- Improved chat input behavior:
  - reduced duplicate prompt submissions
  - multiline/image paste placeholder workflow updates
- Added NVIDIA NIM provider support.
