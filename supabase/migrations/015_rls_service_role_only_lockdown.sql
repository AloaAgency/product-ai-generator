-- Migration: 015_rls_service_role_only_lockdown.sql
-- Purpose: Lock down three tables flagged by the Night Sweep on 2026-04-25
--          (PR #154) that currently have FOR ALL USING (true) WITH CHECK (true)
--          policies with no role restriction — meaning ANY authenticated user
--          can SELECT/UPDATE/DELETE any row.
--
-- Tables affected:
--   1. prodai_projects (CRITICAL: stores Gemini API keys in global_style_settings)
--   2. prodai_settings_templates
--   3. prodai_error_logs
--
-- Why service-role-only (not auth.uid() = user_id as PR #154 suggested):
--   - All app routes that touch these tables use createServiceClient()
--     (server-side service-role) — there are NO authenticated/anon code paths
--   - prodai_projects rows are inserted with PLACEHOLDER_USER_ID
--     '00000000-0000-0000-0000-000000000000' — auth.uid() would never match
--     any real user, locking everyone out
--   - Service-role-only matches the actual access pattern and provides full
--     defense against direct PostgREST access using a leaked anon key
--
-- This migration is idempotent: existing broad policies are dropped before
-- the service-role-only policies are created.

BEGIN;

-- =============================================================================
-- 1. prodai_projects — drop "Allow all access to projects" (010_projects.sql:37)
-- =============================================================================

DROP POLICY IF EXISTS "Allow all access to projects" ON public.prodai_projects;

-- Defensive: also drop any previously-created service-role policy under a
-- conflicting name so we don't error on re-run.
DROP POLICY IF EXISTS "prodai_projects_service_role_only" ON public.prodai_projects;

CREATE POLICY "prodai_projects_service_role_only"
  ON public.prodai_projects
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- 2. prodai_settings_templates — drop "Service role full access on settings_templates"
--    The existing policy was named for service_role but had NO role restriction
--    (011_settings_templates.sql:17-21). Replace with a properly TO-scoped one.
-- =============================================================================

DROP POLICY IF EXISTS "Service role full access on settings_templates"
  ON public.prodai_settings_templates;

DROP POLICY IF EXISTS "prodai_settings_templates_service_role_only"
  ON public.prodai_settings_templates;

CREATE POLICY "prodai_settings_templates_service_role_only"
  ON public.prodai_settings_templates
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- 3. prodai_error_logs — drop "Allow all for error_logs" (014_error_logs.sql:15)
-- =============================================================================

DROP POLICY IF EXISTS "Allow all for error_logs" ON public.prodai_error_logs;

DROP POLICY IF EXISTS "prodai_error_logs_service_role_only" ON public.prodai_error_logs;

CREATE POLICY "prodai_error_logs_service_role_only"
  ON public.prodai_error_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
