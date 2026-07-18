# Product AI Generator

Next.js application for AI-powered product **image and video** generation. Organize work
by project and product, build prompts from reusable style settings and reference images,
then generate images (Gemini) and videos (Veo / LTX) through a background job queue.

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19, TypeScript
- **Styling:** Tailwind CSS v4
- **State:** Zustand (`src/lib/store.ts`)
- **Data / Storage / Auth:** Supabase (Postgres + Storage, RLS enabled)
- **AI:** Anthropic Claude (prompt assistance), Google Gemini (images + Veo video), LTX (video)
- **Media:** `sharp` (image processing/thumbnails), `fluent-ffmpeg` + `ffmpeg-static` (video thumbnails)
- **Testing:** Vitest (unit) + Playwright (e2e)

## Prerequisites

- Node.js 20+
- A Supabase project (URL, anon key, service-role key)
- API keys for Gemini / Google AI and (optionally) LTX

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
# then fill in the values (see "Environment Variables" below)

# 3. Apply database migrations to your Supabase project
#    Run the SQL files in supabase/migrations/ in numeric order
#    (via the Supabase SQL editor or the Supabase CLI).

# 4. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The whole app is gated behind
`SITE_PASSWORD` (enforced by `src/middleware.ts`); you'll be prompted to log in.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run lint` | Lint with ESLint |
| `npm run test` | Run Vitest unit tests |
| `npm run e2e` | Run Playwright e2e tests |
| `npm run e2e:install` | Install the Playwright Chromium browser |
| `npm run e2e:ui` | Run Playwright in UI mode |

One-off maintenance scripts live in `scripts/` (e.g. `backfill-image-thumbs.mjs`,
`backfill-video-thumbs.mjs`).

## Environment Variables

See `.env.example` for the full annotated list. The essentials:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (**server only**) |
| `SITE_PASSWORD` | Password that gates the entire app |
| `ADMIN_SECRET` | Auth for admin-only API endpoints (`x-admin-secret` header) |
| `CRON_SECRET` | Auth for the worker endpoint (`x-cron-secret` or `Bearer`) |
| `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` | Gemini images + Veo video |
| `LTX_API_KEY` | LTX video generation |
| `BFT_*` | Aloa Bug & Feature Tracker integration |

Many generation/Veo/LTX tuning knobs are optional and have sensible defaults — see the
commented section at the bottom of `.env.example`.

> Never prefix server-only secrets with `NEXT_PUBLIC_`.

## Architecture

### Routing

Work is scoped under `/projects/[projectId]/products/[id]/…` with tabs for
generate, scenes, storyboard, gallery, references, prompts, settings, and log.
The legacy `/products/[id]/…` routes still exist purely as redirects to the
project-scoped equivalents.

### Background generation queue

Long-running image and video generation must **not** run inline in production (it
exceeds serverless request limits). Instead:

1. An API route enqueues a row in the `generation_jobs` table.
2. The worker at `/api/worker/generate` (triggered by a Vercel cron every minute —
   see `vercel.json`) picks up pending jobs and processes them.
3. Video jobs reuse `generation_jobs` with `job_type = 'video'` and `scene_id` set.

Concurrency and batch size are controlled by env vars
(`GENERATION_JOB_CONCURRENCY`, `IMAGE_JOB_CONCURRENCY`, `VIDEO_JOB_CONCURRENCY`,
`GENERATION_JOB_BATCH_SIZE`, …). Set `INLINE_GENERATION=true` for local debugging only.

### Keys & settings

Gemini API keys are stored per project in `global_style_settings.gemini_api_key`
and used server-side for both Gemini images and Veo video.

### Logging

- Use the scoped logger in `src/lib/logger.ts` for diagnostic console output —
  `debug`/`info` are silenced in production while `warn`/`error` always pass through.
- Persist user-facing/operational errors to the database via `logError` in
  `src/lib/error-logger.ts` (surfaced in the in-app Log tab).

## UI Conventions

- **Escape** closes all modals/overlays; **Cmd/Ctrl+Enter** submits modal forms;
  clicking the backdrop closes the modal. Use `useModalShortcuts`
  (`src/hooks/useModalShortcuts.ts`) — all three behaviors are expected on every modal.
- Number inputs are string-backed and allow clearing while typing; clamp/validate on
  blur or submit, not on every keystroke.
- Veo duration must be `8` when using reference images or 1080p/4k resolution; only
  720p without reference images allows 4 or 6 seconds.

## Testing

```bash
npm run test            # unit tests (Vitest)
npm run e2e:install     # one-time: install Playwright Chromium
npm run e2e             # end-to-end tests (Playwright)
```

## Deployment

Deployed on Vercel. The cron in `vercel.json` invokes `/api/worker/generate` every
minute to drain the generation queue. Ensure all environment variables (including
`CRON_SECRET`) are configured in the Vercel project.

The audited external-receiver inventory and requirements for adding a signed
webhook are documented in [`docs/webhook-security.md`](docs/webhook-security.md).

## Bug & Feature Tracking

This project uses the **Aloa Bug & Feature Tracker (BFT)**, not GitHub Issues.
</content>
</invoke>
