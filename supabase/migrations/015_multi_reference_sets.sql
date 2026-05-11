-- Multi-reference-set support: replace per-job reference_set_id/texture_set_id/counts
-- with a join table so a single generation can reference N subject sets + N texture sets.

CREATE TABLE prodai_generation_job_reference_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES prodai_generation_jobs(id) ON DELETE CASCADE,
  reference_set_id UUID NOT NULL REFERENCES prodai_reference_sets(id),
  role TEXT NOT NULL CHECK (role IN ('subject', 'texture')),
  display_order INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER,
  subject_label TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_generation_job_reference_sets_job_order
  ON prodai_generation_job_reference_sets(job_id, display_order);

CREATE INDEX idx_generation_job_reference_sets_reference_set_id
  ON prodai_generation_job_reference_sets(reference_set_id);

-- Backfill: existing single-set jobs become role='subject', texture sets become role='texture'.
-- Subjects get display_order=0 so they always appear before textures in the prompt's image list.
INSERT INTO prodai_generation_job_reference_sets (job_id, reference_set_id, role, display_order, image_count)
SELECT id, reference_set_id, 'subject', 0, product_image_count
FROM prodai_generation_jobs
WHERE reference_set_id IS NOT NULL;

INSERT INTO prodai_generation_job_reference_sets (job_id, reference_set_id, role, display_order, image_count)
SELECT id, texture_set_id, 'texture', 1, texture_image_count
FROM prodai_generation_jobs
WHERE texture_set_id IS NOT NULL;

ALTER TABLE prodai_generation_jobs
  DROP COLUMN reference_set_id,
  DROP COLUMN texture_set_id,
  DROP COLUMN product_image_count,
  DROP COLUMN texture_image_count;

ALTER TABLE public.prodai_generation_job_reference_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "generation_job_reference_sets_select_own"
  ON public.prodai_generation_job_reference_sets
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.prodai_generation_jobs j
    JOIN public.prodai_products p ON p.id = j.product_id
    WHERE j.id = job_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "generation_job_reference_sets_insert_own"
  ON public.prodai_generation_job_reference_sets
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.prodai_generation_jobs j
    JOIN public.prodai_products p ON p.id = j.product_id
    WHERE j.id = job_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "generation_job_reference_sets_update_own"
  ON public.prodai_generation_job_reference_sets
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.prodai_generation_jobs j
    JOIN public.prodai_products p ON p.id = j.product_id
    WHERE j.id = job_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.prodai_generation_jobs j
    JOIN public.prodai_products p ON p.id = j.product_id
    WHERE j.id = job_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "generation_job_reference_sets_delete_own"
  ON public.prodai_generation_job_reference_sets
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.prodai_generation_jobs j
    JOIN public.prodai_products p ON p.id = j.product_id
    WHERE j.id = job_id AND p.user_id = auth.uid()
  ));
