# Agent Notes

- Long-running generation (image + video) must enqueue a `generation_jobs` record and be processed by `/api/worker/generate` to avoid production request limits.
- Video jobs reuse `generation_jobs` with `job_type = 'video'` and `scene_id` populated; do not run video generation inline in production.
- Concurrency is controlled via `VIDEO_JOB_CONCURRENCY` (and `IMAGE_JOB_CONCURRENCY` / `GENERATION_JOB_CONCURRENCY` defaults); ensure `GENERATION_JOB_BATCH_SIZE` is >= the concurrency you want processed per tick.
- Gemini API keys are stored per project in `global_style_settings.gemini_api_key` and are used server-side for Gemini images and Veo video.
