-- 1. Expand approval_status CHECK constraint
ALTER TABLE prodai_generated_images
  DROP CONSTRAINT IF EXISTS prodai_generated_images_approval_status_check;
ALTER TABLE prodai_generated_images
  ADD CONSTRAINT prodai_generated_images_approval_status_check
  CHECK (approval_status IN ('approved', 'rejected', 'pending', 'request_changes'));

-- 2. Add source_image_id to generation_jobs (for Fix Image jobs)
ALTER TABLE prodai_generation_jobs
  ADD COLUMN IF NOT EXISTS source_image_id UUID REFERENCES prodai_generated_images(id) ON DELETE SET NULL;
