-- Add direct product_id ownership path to prodai_generated_images RLS policies.
--
-- Migration 007 created policies that check ownership through job_id or scene_id.
-- Migration 014 added a product_id column and backfilled it from those relations.
-- Any row where product_id is set but both job_id and scene_id are NULL is
-- unreachable by the original policies. This migration replaces all four policies
-- with versions that also accept a direct product_id match.

DROP POLICY IF EXISTS "generated_images_select_own" ON public.prodai_generated_images;
DROP POLICY IF EXISTS "generated_images_insert_own" ON public.prodai_generated_images;
DROP POLICY IF EXISTS "generated_images_update_own" ON public.prodai_generated_images;
DROP POLICY IF EXISTS "generated_images_delete_own" ON public.prodai_generated_images;

CREATE POLICY "generated_images_select_own" ON public.prodai_generated_images
  FOR SELECT TO authenticated
  USING (
    (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.prodai_products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    ))
    OR
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
    (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.prodai_products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    ))
    OR
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
    (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.prodai_products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    ))
    OR
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
    (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.prodai_products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    ))
    OR
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
    (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.prodai_products p
      WHERE p.id = product_id AND p.user_id = auth.uid()
    ))
    OR
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
