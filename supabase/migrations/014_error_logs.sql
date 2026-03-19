CREATE TABLE prodai_error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES prodai_projects(id) ON DELETE CASCADE,
  product_id UUID REFERENCES prodai_products(id) ON DELETE CASCADE,
  error_message TEXT NOT NULL,
  error_source TEXT,
  error_context JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_error_logs_project ON prodai_error_logs(project_id, created_at DESC);
CREATE INDEX idx_error_logs_product ON prodai_error_logs(product_id, created_at DESC);

ALTER TABLE prodai_error_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for error_logs" ON prodai_error_logs FOR ALL USING (true) WITH CHECK (true);
