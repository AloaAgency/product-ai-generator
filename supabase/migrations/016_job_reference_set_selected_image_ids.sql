-- Allow callers to pin specific reference images for a generation job, instead of
-- relying on "first N by display_order". When NULL, behavior is unchanged.

ALTER TABLE prodai_generation_job_reference_sets
  ADD COLUMN selected_image_ids UUID[];
