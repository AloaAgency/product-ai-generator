# Agent Notes

- Long-running generation (image + video) must enqueue a `generation_jobs` record and be processed by `/api/worker/generate` to avoid production request limits.
- Video jobs reuse `generation_jobs` with `job_type = 'video'` and `scene_id` populated; do not run video generation inline in production.
- Concurrency is controlled via `VIDEO_JOB_CONCURRENCY` (and `IMAGE_JOB_CONCURRENCY` / `GENERATION_JOB_CONCURRENCY` defaults); ensure `GENERATION_JOB_BATCH_SIZE` is >= the concurrency you want processed per tick.
