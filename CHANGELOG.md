# Changelog

## 0.0.5 - 2026-03-05
- Improved no-browser web search reliability:
  - `web.search` now uses DuckDuckGo free API first, then falls back to both HTML and lite result pages.
  - Expanded DuckDuckGo result parsing patterns to capture more result link formats.
- Removed AI turn safety cap (no max-step limit); turns now continue until completion or explicit abort.
- Removed auto-continue configuration from interactive chat UX:
  - removed `/autocontinue` command
  - removed auto-continue from config wizard, status header, help, and autocomplete

## 0.0.4 - 2026-03-05
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
