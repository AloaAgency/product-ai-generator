-- Enable RLS and add ownership-based policies for public tables

ALTER TABLE public.prodai_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prodai_reference_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prodai_reference_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prodai_prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prodai_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prodai_storyboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prodai_storyboard_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prodai_generated_images ENABLE ROW LEVEL SECURITY;

-- Products
CREATE POLICY "products_select_own" ON public.prodai_products
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "products_insert_own" ON public.prodai_products
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "products_update_own" ON public.prodai_products
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "products_delete_own" ON public.prodai_products
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Reference sets
CREATE POLICY "reference_sets_select_own" ON public.prodai_reference_sets
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "reference_sets_insert_own" ON public.prodai_reference_sets
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "reference_sets_update_own" ON public.prodai_reference_sets
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "reference_sets_delete_own" ON public.prodai_reference_sets
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

-- Reference images
CREATE POLICY "reference_images_select_own" ON public.prodai_reference_images
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.prodai_reference_sets rs
    JOIN public.prodai_products p ON p.id = rs.product_id
    WHERE rs.id = reference_set_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "reference_images_insert_own" ON public.prodai_reference_images
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.prodai_reference_sets rs
    JOIN public.prodai_products p ON p.id = rs.product_id
    WHERE rs.id = reference_set_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "reference_images_update_own" ON public.prodai_reference_images
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.prodai_reference_sets rs
    JOIN public.prodai_products p ON p.id = rs.product_id
    WHERE rs.id = reference_set_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.prodai_reference_sets rs
    JOIN public.prodai_products p ON p.id = rs.product_id
    WHERE rs.id = reference_set_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "reference_images_delete_own" ON public.prodai_reference_images
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.prodai_reference_sets rs
    JOIN public.prodai_products p ON p.id = rs.product_id
    WHERE rs.id = reference_set_id AND p.user_id = auth.uid()
  ));

-- Prompt templates
CREATE POLICY "prompt_templates_select_own" ON public.prodai_prompt_templates
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "prompt_templates_insert_own" ON public.prodai_prompt_templates
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "prompt_templates_update_own" ON public.prodai_prompt_templates
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "prompt_templates_delete_own" ON public.prodai_prompt_templates
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

-- Generation jobs
CREATE POLICY "generation_jobs_select_own" ON public.prodai_generation_jobs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "generation_jobs_insert_own" ON public.prodai_generation_jobs
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "generation_jobs_update_own" ON public.prodai_generation_jobs
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "generation_jobs_delete_own" ON public.prodai_generation_jobs
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

-- Storyboards
CREATE POLICY "storyboards_select_own" ON public.prodai_storyboards
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "storyboards_insert_own" ON public.prodai_storyboards
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "storyboards_update_own" ON public.prodai_storyboards
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "storyboards_delete_own" ON public.prodai_storyboards
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

-- Storyboard scenes
CREATE POLICY "storyboard_scenes_select_own" ON public.prodai_storyboard_scenes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "storyboard_scenes_insert_own" ON public.prodai_storyboard_scenes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "storyboard_scenes_update_own" ON public.prodai_storyboard_scenes
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "storyboard_scenes_delete_own" ON public.prodai_storyboard_scenes
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

-- Generated images (via job or scene ownership)
CREATE POLICY "generated_images_select_own" ON public.prodai_generated_images
  FOR SELECT TO authenticated
  USING (
    (job_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_generation_jobs j
      JOIN public.prodai_products p ON p.id = j.product_id
      WHERE j.id = job_id AND p.user_id = auth.uid()
    ))
    OR
    (scene_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_storyboard_scenes s
      JOIN public.prodai_products p ON p.id = s.product_id
      WHERE s.id = scene_id AND p.user_id = auth.uid()
    ))
  );

CREATE POLICY "generated_images_insert_own" ON public.prodai_generated_images
  FOR INSERT TO authenticated
  WITH CHECK (
    (job_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_generation_jobs j
      JOIN public.prodai_products p ON p.id = j.product_id
      WHERE j.id = job_id AND p.user_id = auth.uid()
    ))
    OR
    (scene_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_storyboard_scenes s
      JOIN public.prodai_products p ON p.id = s.product_id
      WHERE s.id = scene_id AND p.user_id = auth.uid()
    ))
  );

CREATE POLICY "generated_images_update_own" ON public.prodai_generated_images
  FOR UPDATE TO authenticated
  USING (
    (job_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_generation_jobs j
      JOIN public.prodai_products p ON p.id = j.product_id
      WHERE j.id = job_id AND p.user_id = auth.uid()
    ))
    OR
    (scene_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_storyboard_scenes s
      JOIN public.prodai_products p ON p.id = s.product_id
      WHERE s.id = scene_id AND p.user_id = auth.uid()
    ))
  )
  WITH CHECK (
    (job_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_generation_jobs j
      JOIN public.prodai_products p ON p.id = j.product_id
      WHERE j.id = job_id AND p.user_id = auth.uid()
    ))
    OR
    (scene_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_storyboard_scenes s
      JOIN public.prodai_products p ON p.id = s.product_id
      WHERE s.id = scene_id AND p.user_id = auth.uid()
    ))
  );

CREATE POLICY "generated_images_delete_own" ON public.prodai_generated_images
  FOR DELETE TO authenticated
  USING (
    (job_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_generation_jobs j
      JOIN public.prodai_products p ON p.id = j.product_id
      WHERE j.id = job_id AND p.user_id = auth.uid()
    ))
    OR
    (scene_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.prodai_storyboard_scenes s
      JOIN public.prodai_products p ON p.id = s.product_id
      WHERE s.id = scene_id AND p.user_id = auth.uid()
    ))
  );
