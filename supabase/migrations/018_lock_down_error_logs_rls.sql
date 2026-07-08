-- Lock down prodai_error_logs RLS.
--
-- Background:
--   - 014_error_logs.sql created the table with a blanket policy:
--       FOR ALL USING (true) WITH CHECK (true)
--     which allowed any authenticated user to read, modify, and delete every
--     error log row.
--   - 017_fix_rls_projects_settings_templates.sql fixed projects + settings_templates
--     but deliberately deferred this table because it has no direct user_id column
--     and both project_id / product_id FKs are nullable, making the right
--     ownership scope ambiguous.
--
-- Decision (after code audit):
--   - Only writer:  src/lib/error-logger.ts → createServiceClient() → service role
--   - Only reader:  src/app/api/error-logs/route.ts → createServiceClient() → service role
--   - No code path uses the authenticated/anon key against this table.
--
-- Therefore: explicitly deny all access from authenticated and anon roles.
-- Service role bypasses RLS, so the worker and API route keep functioning.
-- Any future code that accidentally uses a user-scoped client to read or write
-- error logs will fail closed instead of leaking other tenants' rows.
--
-- Note: this does NOT fix the API-route-level authorization gap on
-- /api/error-logs (which trusts a query-string project_id without verifying
-- the requesting user owns the project). That's a separate API change because
-- the route uses service role and RLS cannot intervene.

DROP POLICY IF EXISTS "Allow all for error_logs" ON public.prodai_error_logs;

CREATE POLICY "error_logs_deny_authenticated" ON public.prodai_error_logs
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "error_logs_deny_anon" ON public.prodai_error_logs
  FOR ALL TO anon
  USING (false)
  WITH CHECK (false);
