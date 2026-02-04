-- Add type field to reference sets (product vs texture)
ALTER TABLE prodai_reference_sets
ADD COLUMN type TEXT NOT NULL DEFAULT 'product'
CHECK (type IN ('product', 'texture'));

-- Add texture-related fields to generation jobs
ALTER TABLE prodai_generation_jobs
ADD COLUMN texture_set_id UUID REFERENCES prodai_reference_sets(id),
ADD COLUMN product_image_count INTEGER,
ADD COLUMN texture_image_count INTEGER;
