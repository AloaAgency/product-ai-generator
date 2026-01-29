-- Add video generation support to scenes and gallery

-- Scenes: add model + motion prompt
ALTER TABLE prodai_storyboard_scenes
  ADD COLUMN generation_model TEXT DEFAULT 'veo3',
  ADD COLUMN motion_prompt TEXT;

-- Generated images: support video media type + scene linkage
ALTER TABLE prodai_generated_images
  ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image',
  ADD COLUMN scene_id UUID REFERENCES prodai_storyboard_scenes(id) ON DELETE SET NULL,
  ADD COLUMN scene_name TEXT;

ALTER TABLE prodai_generated_images
  ADD CONSTRAINT chk_media_type CHECK (media_type IN ('image', 'video'));

CREATE INDEX idx_generated_images_scene ON prodai_generated_images(scene_id);

-- Prompt templates: distinguish image vs video prompts
ALTER TABLE prodai_prompt_templates
  ADD COLUMN prompt_type TEXT NOT NULL DEFAULT 'image';

ALTER TABLE prodai_prompt_templates
  ADD CONSTRAINT chk_prompt_type CHECK (prompt_type IN ('image', 'video'));
