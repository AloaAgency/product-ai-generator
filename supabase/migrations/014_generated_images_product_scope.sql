-- Scope gallery queries directly by product instead of resolving through jobs/scenes.

ALTER TABLE prodai_generated_images
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES prodai_products(id) ON DELETE CASCADE;

-- Backfill product ownership from the generation job relationship first.
UPDATE prodai_generated_images AS img
SET product_id = job.product_id
FROM prodai_generation_jobs AS job
WHERE img.product_id IS NULL
  AND img.job_id = job.id;

-- Fill any remaining rows from the scene relationship.
UPDATE prodai_generated_images AS img
SET product_id = scene.product_id
FROM prodai_storyboard_scenes AS scene
WHERE img.product_id IS NULL
  AND img.scene_id = scene.id;

CREATE INDEX IF NOT EXISTS idx_generated_images_product_created
  ON prodai_generated_images(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_images_product_scene_created
  ON prodai_generated_images(product_id, scene_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_images_product_variation_created
  ON prodai_generated_images(product_id, variation_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_images_product_status_media_created
  ON prodai_generated_images(product_id, approval_status, media_type, created_at DESC);
