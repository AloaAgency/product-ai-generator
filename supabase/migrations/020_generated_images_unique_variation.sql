-- Backstop against duplicate variations for the same generation job.
-- The worker already checks recorded variation numbers before generating, but
-- nothing at the database level prevented two concurrent writers (e.g. a
-- requeued job overlapping a still-running worker) from inserting the same
-- (job_id, variation_number, media_type) twice.

-- Remove any existing duplicates first, keeping the earliest row.
DELETE FROM prodai_generated_images AS dup
USING prodai_generated_images AS keep
WHERE dup.job_id IS NOT NULL
  AND dup.job_id = keep.job_id
  AND dup.variation_number = keep.variation_number
  AND dup.media_type = keep.media_type
  AND (
    dup.created_at > keep.created_at
    OR (dup.created_at = keep.created_at AND dup.id > keep.id)
  );

-- Gallery uploads have job_id NULL and are exempt (partial index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_images_job_variation_media
  ON prodai_generated_images(job_id, variation_number, media_type)
  WHERE job_id IS NOT NULL;
