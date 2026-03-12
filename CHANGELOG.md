# Changelog

## 0.0.14 - 2026-03-12
- Added global skills support:
  - `/skill add <path/to/SKILL.md>` installs a skill into `~/.config/cognautic-forge/skills/<name>/SKILL.md` (supports `~/...` paths)
  - `/skill list` shows installed skills
- Updated agent behavior around skills:
  - system prompt lists installed skill files
  - for design/redesign/UI/UX-type requests, the AI is forced to `files.read` relevant skill files before starting work
- Updated chat spinner label to show `reading <skill> skill file` during those skill reads

## 0.0.13 - 2026-03-11
- Fixed AI response stopping via Escape key:
  - compositor now explicitly resumes `stdin` after pausing `readline` to ensure raw key events (ESC/Ctrl+C) are detected during AI turns
  - improved abort reliability by eliminating the async gap where `stdin` was paused before the thinking-mode handler was fully armed

## 0.0.12 - 2026-03-09
- Improved interactive chat UI:
  - MCP server warmup starts on load with compact status output
  - sent user prompts now render as boxed transcript cards
  - resumed chat history renders prior user turns in the same boxed style
  - active input reverted to a plain inline prompt while keeping boxed sent messages
  - removed the standalone `ai>` preface so only the spinner shows while the assistant is thinking, with `ai>` shown only for the actual response
  - startup header now opens with a simplified session info box and divider, without the earlier ASCII/SVG logo rendering
  - improved prompt/response rendering cleanup around submit, abort, and modal confirmation flows
  - tool execution output now renders with per-tool dividers, including a separator between tool traces and final assistant text responses

## 0.0.11 - 2026-03-08
- Fixed Google auth reuse so Forge no longer opens the Google login flow on every restart when saved tokens and scopes are still valid
- Fixed modal prompt rendering so tool confirmations and `user.wait` no longer leak stray `you>` prompt lines like `you> y`
- Updated `user.wait` system guidance so the model tells users to return to Forge and press Enter to continue after manual steps

## 0.0.10 - 2026-03-08
- Fixed Google auth/session handling:
  - token files now live in Forge config storage instead of the current working directory
  - `google.disconnect()` now deletes local tokens even if remote logout fails
  - `GoogleIntegration.isConnected()` now validates a usable access token instead of only checking for a token file
  - `forge auth google` and `/auth google` now request only base login scopes, keeping product scopes incremental
- Fixed another prompt duplication edge case where `/exit` could echo a duplicate `you>` line during shutdown
- Updated `user.wait` system guidance so the model tells users to return to Forge and press Enter to continue after manual steps

## 0.0.9 - 2026-03-08
- Fixed Google auth token storage so Forge no longer requires `FORGE_ENCRYPTION_KEY` explicitly:
  - uses the env var when present
  - falls back to a machine-local derived encryption key otherwise
- Fixed chat shutdown output so the resume hint no longer inherits a stale `you>` prompt prefix
- Added Forge footer legal links only on the Forge website page
- Added Forge docs-style Terms of Service and Privacy Policy pages under the Forge website section
- Restored the main website homepage after an accidental corruption in the website repo

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
