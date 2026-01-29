-- Make scenes independent entities that can exist without a storyboard

-- Add product_id so scenes can be queried by product directly
ALTER TABLE prodai_storyboard_scenes
  ADD COLUMN product_id UUID REFERENCES prodai_products(id) ON DELETE CASCADE;

-- Backfill product_id from storyboard
UPDATE prodai_storyboard_scenes s
  SET product_id = b.product_id
  FROM prodai_storyboards b
  WHERE s.storyboard_id = b.id;

-- Make product_id required going forward
ALTER TABLE prodai_storyboard_scenes
  ALTER COLUMN product_id SET NOT NULL;

-- Make storyboard_id optional (scenes can be loose)
ALTER TABLE prodai_storyboard_scenes
  ALTER COLUMN storyboard_id DROP NOT NULL;

-- Make scene_order optional (loose scenes don't need ordering)
ALTER TABLE prodai_storyboard_scenes
  ALTER COLUMN scene_order DROP NOT NULL;

CREATE INDEX idx_storyboard_scenes_product ON prodai_storyboard_scenes(product_id);
