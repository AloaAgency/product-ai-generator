-- Harden RLS on prodai_projects and prodai_settings_templates.
--
-- Both tables were created with blanket USING (true) / WITH CHECK (true) policies
-- that allowed any authenticated user to read and write every row. This migration
-- replaces those policies with owner-scoped policies consistent with every other
-- table in the schema (reference_sets, prompt_templates, generation_jobs, etc.).
--
-- prodai_error_logs also carries a blanket policy but its nullable FK columns
-- (project_id, product_id) and lack of a direct user_id make the correct scope
-- ambiguous at the DB layer; that table's policy is left for human review.

-- ─────────────────────────────────────────────
-- prodai_projects — has a direct user_id column
-- ─────────────────────────────────────────────

DROP POLICY IF EXISTS "Allow all access to projects" ON public.prodai_projects;

CREATE POLICY "projects_select_own" ON public.prodai_projects
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "projects_insert_own" ON public.prodai_projects
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "projects_update_own" ON public.prodai_projects
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "projects_delete_own" ON public.prodai_projects
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────────────────
-- prodai_settings_templates — no direct user_id; ownership via product_id
-- (same EXISTS pattern used by prompt_templates, reference_sets, etc.)
-- ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Service role full access on settings_templates" ON public.prodai_settings_templates;

CREATE POLICY "settings_templates_select_own" ON public.prodai_settings_templates
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "settings_templates_insert_own" ON public.prodai_settings_templates
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "settings_templates_update_own" ON public.prodai_settings_templates
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "settings_templates_delete_own" ON public.prodai_settings_templates
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.prodai_products p
    WHERE p.id = product_id AND p.user_id = auth.uid()
  ));
