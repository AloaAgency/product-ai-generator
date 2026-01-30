-- Add per-scene video generation settings
ALTER TABLE prodai_storyboard_scenes
  ADD COLUMN video_resolution TEXT,
  ADD COLUMN video_aspect_ratio TEXT,
  ADD COLUMN video_duration_seconds INTEGER,
  ADD COLUMN video_fps INTEGER,
  ADD COLUMN video_generate_audio BOOLEAN;
