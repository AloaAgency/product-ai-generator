-- Support video jobs in the shared generation queue

ALTER TABLE prodai_generation_jobs
  ADD COLUMN job_type TEXT NOT NULL DEFAULT 'image',
  ADD COLUMN scene_id UUID REFERENCES prodai_storyboard_scenes(id) ON DELETE SET NULL;

ALTER TABLE prodai_generation_jobs
  ADD CONSTRAINT chk_generation_job_type CHECK (job_type IN ('image', 'video'));

ALTER TABLE prodai_generation_jobs
  ALTER COLUMN reference_set_id DROP NOT NULL;

CREATE INDEX idx_prodai_generation_jobs_scene_id ON prodai_generation_jobs(scene_id);
