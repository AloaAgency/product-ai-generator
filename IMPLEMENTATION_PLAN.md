# Product AI Generator — Implementation Plan

## Vision
A standalone app for generating hyper-realistic product images using **reference image sets** (e.g., 3D model renders from multiple angles) combined with **Claude prompt engineering** and **Gemini / Nano Banana image generation** (same API — "Nano Banana" is our nickname for Gemini's image generation). The app ensures the AI always has the correct reference images so you can generate unlimited, consistent product imagery.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Product** | A real, unchanging product (e.g., a physical item, 3D model). Has a name, description, and one or more Reference Sets. |
| **Reference Set** | A collection of images showing the product from many angles/contexts. One set is "active" at a time per product. You can switch between sets. |
| **Global Style Settings** | Per-product default prompt rules (lens, lighting, constraints, fidelity). Applied to every generation unless overridden. |
| **Prompt Template** | A reusable scene description (e.g., "product on a wooden table in a café"). Combined with global settings to form the full generation prompt. |
| **Generation Job** | One prompt × N variations (e.g., 15 attempts). Each variation is sent to the image API with the same prompt + reference images. Results are stored for comparison/selection. |
| **Gallery** | All generated images for a product, filterable by prompt, organized for approval/download. |

---

## What We Carry Over from `aloa-creator-publisher`

### Direct reuse (copy & adapt)
| Source file | New location | Adaptation needed |
|-------------|-------------|-------------------|
| `src/app1/lib/gemini.ts` | `src/lib/gemini.ts` | Add reference image support (pass base64 images in `contents[].parts[]`). Add Nano Banana adapter behind same interface. |
| `src/app1/lib/broll-utils.ts` | `src/lib/image-utils.ts` | Rename from "broll" to "product-image". Keep slugify, thumbnail/preview generation, storage path builders. |
| `src/app1/lib/broll-cost.ts` | `src/lib/cost.ts` | Same structure, update env var names. |
| `src/app1/lib/broll-prompts.ts` | `src/lib/prompt-builder.ts` | Replace "video script analysis" with "product image prompt builder". Keep JSON parsing logic. |
| `src/shared/lib/claude-models.ts` | `src/lib/claude-models.ts` | Copy as-is. |
| `src/app1/components/BrollLightboxModal.tsx` | `src/components/ImageLightbox.tsx` | Rename props, remove scene/video concepts, add "variation N of M" display. |

### Architecture patterns to reuse
- **Additive generation** — never replace, always add new images. User picks best.
- **Thumbnail + preview pipeline** via `sharp` (480px thumb, 1600px preview, both WebP).
- **SSE streaming** for generation progress.
- **Retry with exponential backoff** for image API calls.
- **Style presets** stored in DB, one default per product.
- **Approval workflow** (approve/reject/download in lightbox).

---

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Framework | **Next.js 16** (App Router) | Already scaffolded |
| UI | **Tailwind CSS 4** + **shadcn/ui** | Dark mode from day 1 |
| State | **Zustand** | Lightweight, proven in parent app |
| DB | **Supabase** (Postgres + Storage + Auth + RLS) | Same project or new — share credentials |
| Image Gen | **Gemini API** (aka "Nano Banana") | Proven in parent app |
| Prompt Gen | **Claude API** (Haiku → Sonnet fallback) | Same as parent |
| Image Processing | **sharp** | Thumbnails, previews |

---

## Database Schema

### `products`
```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL,
  description TEXT,
  global_style_settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- RLS: user_id = auth.uid()
```

`global_style_settings` JSONB example:
```json
{
  "subject_rule": "show the EXACT PRODUCT visible in the attached reference images...",
  "lens": "35mm full frame f1.2 lens unless otherwise stated",
  "camera_height": "chest level or slightly low angle",
  "color_grading": "neutral cinematic, muted greens and industrial grays, low saturation, realistic contrast",
  "lighting": "natural light only",
  "style": "photorealistic, cinematic, magazine centerfold, forty-foot-trade-show-banner iconic",
  "constraints": "no logos, no text, no sci-fi styling, no design changes",
  "reference_rule": "the attached images define the product. The image generator must match them exactly.",
  "default_resolution": "4K",
  "default_aspect_ratio": "16:9",
  "default_fidelity": "high",
  "custom_suffix": ""
}
```

### `reference_sets`
```sql
CREATE TABLE reference_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT false,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- Only one active per product (enforced in app logic)
```

### `reference_images`
```sql
CREATE TABLE reference_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_set_id UUID NOT NULL REFERENCES reference_sets(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  public_url TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### `prompt_templates`
```sql
CREATE TABLE prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `generation_jobs`
```sql
CREATE TABLE generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  prompt_template_id UUID REFERENCES prompt_templates(id),
  reference_set_id UUID NOT NULL REFERENCES reference_sets(id),
  final_prompt TEXT NOT NULL,
  variation_count INTEGER NOT NULL DEFAULT 15,
  resolution TEXT NOT NULL DEFAULT '4K',
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','cancelled')),
  completed_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_message TEXT,
  generation_model TEXT DEFAULT 'gemini',
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
```

### `generated_images`
```sql
CREATE TABLE generated_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  variation_number INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  public_url TEXT,
  thumb_storage_path TEXT,
  thumb_public_url TEXT,
  preview_storage_path TEXT,
  preview_public_url TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  approval_status TEXT CHECK (approval_status IN ('approved','rejected','pending')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## App Routes & Pages

```
/                           → Landing / product list
/products/new               → Create product + upload first reference set
/products/[id]              → Product dashboard (reference sets, prompts, gallery)
/products/[id]/references   → Manage reference sets & images
/products/[id]/settings     → Global style settings editor
/products/[id]/generate     → Prompt builder + batch generation UI
/products/[id]/gallery      → All generated images (filter by job/prompt, lightbox)
```

---

## API Routes

```
POST   /api/products                         → Create product
GET    /api/products                         → List products
GET    /api/products/[id]                    → Get product details
PATCH  /api/products/[id]                    → Update product / settings
DELETE /api/products/[id]                    → Delete product

POST   /api/products/[id]/reference-sets              → Create reference set
GET    /api/products/[id]/reference-sets              → List reference sets
PATCH  /api/products/[id]/reference-sets/[setId]      → Update / activate set
DELETE /api/products/[id]/reference-sets/[setId]      → Delete set

POST   /api/products/[id]/reference-sets/[setId]/images  → Upload reference images
DELETE /api/products/[id]/reference-sets/[setId]/images/[imgId] → Delete ref image

POST   /api/products/[id]/prompts            → Create prompt template
GET    /api/products/[id]/prompts            → List prompt templates
PATCH  /api/products/[id]/prompts/[promptId] → Update prompt
DELETE /api/products/[id]/prompts/[promptId] → Delete prompt

POST   /api/products/[id]/generate           → Start generation job (N variations)
GET    /api/products/[id]/generate/[jobId]   → Get job status + results (SSE support)
POST   /api/products/[id]/generate/[jobId]/cancel → Cancel running job

GET    /api/products/[id]/gallery            → All generated images for product
PATCH  /api/images/[imageId]                 → Approve/reject/download
DELETE /api/images/[imageId]                 → Delete generated image

POST   /api/ai/build-prompt                  → Claude: refine user prompt with global settings
POST   /api/ai/suggest-prompts              → Claude: suggest N prompt ideas for a product
```

---

## Key Implementation Details

### 1. Reference Image Injection into Gemini
The Gemini API supports multi-part content including images. We pass reference images as base64 inline data alongside the text prompt:

```typescript
const contents = [{
  role: 'user',
  parts: [
    // Reference images first
    ...referenceImages.map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.base64 }
    })),
    // Then the prompt
    { text: finalPrompt }
  ]
}]
```

### 2. Prompt Assembly
```
[GLOBAL STYLE SETTINGS as "MANDATORY REQUIREMENTS" block]
[REFERENCE RULE: "the attached N images define the product..."]
[USER PROMPT: the specific scene/context]
[RESOLUTION/ASPECT suffix]
```

### 3. Variation Generation (15x same prompt)
For each generation job with `variation_count=15`:
- Queue 15 sequential API calls (respect rate limits)
- 500ms delay between calls
- Stream progress via SSE: `{variation: 3, total: 15, status: 'generating'}`
- Each result → thumbnail + preview → Supabase Storage → DB record
- If a call fails, log error, continue to next variation

### 4. Image Processing Pipeline (from parent app)
- Original: PNG/JPEG from API → Supabase Storage
- Thumbnail: 480px WebP (72% quality) via sharp
- Preview: 1600px WebP (82% quality) via sharp
- All three stored, URLs saved in `generated_images` table

---

## Environment Variables (`.env.local`)

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=<same as parent or new project>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same as parent or new project>
SUPABASE_SERVICE_ROLE_KEY=<same as parent or new project>

# AI - Image Generation
GEMINI_API_KEY=<same as parent>
GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview
GEMINI_IMAGE_RESOLUTION_DEFAULT=4K

# AI - Prompt Generation
ANTHROPIC_API_KEY=<same as parent>

# Cost Estimation (optional)
IMAGE_COST_2K=0.00
IMAGE_COST_4K=0.00
CLAUDE_COST_PER_1K=0.00

# Auth
NEXTAUTH_URL=http://localhost:3001
NEXTAUTH_SECRET=<generate new>
```

---

## Implementation Phases

### Phase 1: Core Infrastructure
1. Install dependencies: `supabase`, `@supabase/ssr`, `sharp`, `@anthropic-ai/sdk`, `zustand`, `lucide-react`
2. Copy & adapt `gemini.ts`, `image-utils.ts`, `claude-models.ts`, `cost.ts`, `prompt-builder.ts`
3. Set up Supabase client helpers (copy from parent `src/shared/lib/supabase/`)
4. Create database migrations for all tables
5. Set up `.env.local`

### Phase 2: Product & Reference Management
6. Products CRUD pages + API routes
7. Reference set management UI (upload multiple images, drag to reorder, switch active set)
8. Global style settings editor (structured form for each field in the JSONB)

### Phase 3: Prompt & Generation
9. Prompt template CRUD
10. Claude-powered prompt builder (takes user idea → polished prompt with global settings)
11. Generation job API with SSE streaming
12. Variation generation engine (N calls, progress tracking, additive storage)

### Phase 4: Gallery & Review
13. Gallery page with filtering (by job, prompt, date)
14. Lightbox component (adapted from parent) with approve/reject/download
15. Bulk download of approved images
16. Image comparison view (side-by-side variations)

### Phase 5: Polish
17. Dark mode support
18. Mobile responsive
19. Cost tracking dashboard

---

## External Bug Tracker Integration

Credentials are in `.env.local`:
- `BFT_API_KEY` - API key for authentication
- `BFT_BASE_URL` - Base URL (`https://v0-feature-and-bug-tracker-three.vercel.app/api`)
- `BFT_PROJECT_ID` - Project ID

### Submit a bug/feature:
```bash
curl -s -X POST "${BFT_BASE_URL}/public/items" \
  -H "x-api-key: ${BFT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"project_id": "${BFT_PROJECT_ID}", "title": "Bug title", "description": "Details", "type": "bug", "priority": "medium"}'
```

### Fetch all items:
```bash
curl -s -X GET "${BFT_BASE_URL}/public/items" \
  -H "x-api-key: ${BFT_API_KEY}"
```

### Mark item as complete:
```bash
curl -s -X PATCH "${BFT_BASE_URL}/public/items" \
  -H "x-api-key: ${BFT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"id": "item-uuid", "status": "completed", "changed_by": "claude-code"}'
```

When you fix a bug or implement a feature that matches a tracker item, mark it complete automatically.

---

## Dependencies to Add

```bash
npm install @supabase/supabase-js @supabase/ssr @anthropic-ai/sdk sharp zustand lucide-react
npm install -D @types/sharp
```
