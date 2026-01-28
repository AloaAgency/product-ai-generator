-- Allow scene-generated images without a job
ALTER TABLE prodai_generated_images ALTER COLUMN job_id DROP NOT NULL;

CREATE TABLE prodai_storyboard_scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storyboard_id UUID NOT NULL REFERENCES prodai_storyboards(id) ON DELETE CASCADE,
  scene_order INTEGER NOT NULL,
  title TEXT,
  prompt_text TEXT,
  end_frame_prompt TEXT,
  paired BOOLEAN NOT NULL DEFAULT false,
  start_frame_image_id UUID REFERENCES prodai_generated_images(id) ON DELETE SET NULL,
  end_frame_image_id UUID REFERENCES prodai_generated_images(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_storyboard_scenes_board ON prodai_storyboard_scenes(storyboard_id);
