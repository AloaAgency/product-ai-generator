-- Products
CREATE TABLE prodai_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  global_style_settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Reference Sets
CREATE TABLE prodai_reference_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES prodai_products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT false,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Reference Images
CREATE TABLE prodai_reference_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_set_id UUID NOT NULL REFERENCES prodai_reference_sets(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  public_url TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Prompt Templates
CREATE TABLE prodai_prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES prodai_products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Generation Jobs
CREATE TABLE prodai_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES prodai_products(id) ON DELETE CASCADE,
  prompt_template_id UUID REFERENCES prodai_prompt_templates(id),
  reference_set_id UUID NOT NULL REFERENCES prodai_reference_sets(id),
  final_prompt TEXT NOT NULL,
  variation_count INTEGER NOT NULL DEFAULT 15,
  resolution TEXT NOT NULL DEFAULT '4K',
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','cancelled')),
  completed_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_message TEXT,
  generation_model TEXT DEFAULT 'gemini',
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Generated Images
CREATE TABLE prodai_generated_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES prodai_generation_jobs(id) ON DELETE CASCADE,
  variation_number INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  public_url TEXT,
  thumb_storage_path TEXT,
  thumb_public_url TEXT,
  preview_storage_path TEXT,
  preview_public_url TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  approval_status TEXT CHECK (approval_status IN ('approved','rejected','pending')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_prodai_products_user_id ON prodai_products(user_id);
CREATE INDEX idx_prodai_reference_sets_product_id ON prodai_reference_sets(product_id);
CREATE INDEX idx_prodai_reference_images_set_id ON prodai_reference_images(reference_set_id);
CREATE INDEX idx_prodai_prompt_templates_product_id ON prodai_prompt_templates(product_id);
CREATE INDEX idx_prodai_generation_jobs_product_id ON prodai_generation_jobs(product_id);
CREATE INDEX idx_prodai_generated_images_job_id ON prodai_generated_images(job_id);
