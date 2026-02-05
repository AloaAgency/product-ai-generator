# CLAUDE.md

## Project Overview

Next.js application for AI-powered product image and video generation. Uses Supabase for data/storage, Gemini (Veo) and LTX for video generation.

## UI Conventions

- **Escape** closes ALL modals and overlays app-wide. Use the `useModalShortcuts` hook from `src/hooks/useModalShortcuts.ts`.
- **Cmd/Ctrl+Enter** submits any modal form. Pass `onSubmit` to the hook.
- **Click outside** a modal closes it. Add `onClick={onClose}` to the backdrop div and `onClick={(e) => e.stopPropagation()}` to the modal content div.
- All three behaviors (Escape, Cmd+Enter, click-outside) must be present on every modal.

## Veo Video Constraints

- Duration values must be one of: 4, 6, or 8 seconds.
- Duration must be `8` when using reference images (start/end frames) or with 1080p/4k resolution.
- Only 720p without reference images allows 4 or 6 second durations.
- Audio toggle is LTX-only; Veo audio is gated behind `VEO_SUPPORTS_AUDIO` env var.

## Architecture Notes

- Long-running generation (image + video) must enqueue a `generation_jobs` record and be processed by `/api/worker/generate`.
- Video jobs use `generation_jobs` with `job_type = 'video'` and `scene_id` populated.
- Gemini API keys are stored per project in `global_style_settings.gemini_api_key`.
