-- Create projects table
CREATE TABLE prodai_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  global_style_settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add project_id to products
ALTER TABLE prodai_products
  ADD COLUMN project_id UUID;

-- Backfill: create a Default Project and assign all existing products
DO $$
DECLARE
  default_project_id UUID;
BEGIN
  INSERT INTO prodai_projects (user_id, name, description)
  VALUES ('00000000-0000-0000-0000-000000000000', 'Default Project', 'Auto-created project for existing products')
  RETURNING id INTO default_project_id;

  UPDATE prodai_products SET project_id = default_project_id WHERE project_id IS NULL;
END $$;

-- Now make project_id NOT NULL and add FK
ALTER TABLE prodai_products
  ALTER COLUMN project_id SET NOT NULL,
  ADD CONSTRAINT fk_products_project
    FOREIGN KEY (project_id) REFERENCES prodai_projects(id) ON DELETE CASCADE;

-- RLS for projects
ALTER TABLE prodai_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to projects" ON prodai_projects
  FOR ALL USING (true) WITH CHECK (true);
