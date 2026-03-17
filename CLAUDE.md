# Product AI Generator — Project Knowledge

> Cross-project standards (Supabase, Next.js, API, security, git) are in `~/.claude/CLAUDE.md`. This file covers patterns specific to this app.

## Project Overview

Next.js application for AI-powered product image and video generation. Uses Supabase for data/storage, Gemini (Veo) and LTX for video generation.

## UI Conventions

- **Escape** closes ALL modals and overlays app-wide. Use the `useModalShortcuts` hook from `src/hooks/useModalShortcuts.ts`.
- **Cmd/Ctrl+Enter** submits any modal form. Pass `onSubmit` to the hook.
- **Click outside** a modal closes it. Add `onClick={onClose}` to the backdrop div and `onClick={(e) => e.stopPropagation()}` to the modal content div.
- All three behaviors (Escape, Cmd+Enter, click-outside) must be present on every modal.
- **Number inputs** should be string-backed and allow clearing while typing; clamp/validate on blur or submit instead of forcing values on every keystroke.

## Veo Video Constraints

- Duration values must be one of: 4, 6, or 8 seconds.
- Duration must be `8` when using reference images (start/end frames) or with 1080p/4k resolution.
- Only 720p without reference images allows 4 or 6 second durations.
- Audio toggle is LTX-only; Veo audio is gated behind `VEO_SUPPORTS_AUDIO` env var.

## Architecture Notes

- Long-running generation (image + video) must enqueue a `generation_jobs` record and be processed by `/api/worker/generate`.
- Video jobs use `generation_jobs` with `job_type = 'video'` and `scene_id` populated.
- Gemini API keys are stored per project in `global_style_settings.gemini_api_key`.

### Playwright UI Verification (Claude Code only)
Playwright MCP configured in `.mcp.json` for browser automation.
- After UI changes, use Playwright to visually verify: navigate to the page, take a `browser_snapshot`, check `browser_console_messages` for JS errors, check `browser_network_requests` for failed API calls
- Click through affected features — test happy path + error states
- Close the Playwright-launched Chrome instance when done to avoid orphaned browser processes
