-- Storyboards
CREATE TABLE prodai_storyboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES prodai_products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_prodai_storyboards_product_id ON prodai_storyboards(product_id);
