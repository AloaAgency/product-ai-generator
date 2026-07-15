-- Provision the storage buckets the app depends on.
--
-- The code reads and writes three buckets:
--   reference-images   — uploaded product/texture reference photos
--   generated-images   — AI-generated images plus thumb/preview renditions
--   generated-videos   — AI-generated videos (already provisioned by 009)
--
-- Only generated-videos was ever created by a migration; the other two exist
-- solely because they were created by hand in the Supabase dashboard, so a
-- fresh environment fails on the first reference upload or image generation.
--
-- Both buckets must be PRIVATE. Every access path goes through the
-- service-role client and time-limited signed URLs (createSignedUrl /
-- createSignedUploadUrl — there is no getPublicUrl call in the codebase), and
-- a public bucket would let anyone with a storage path fetch objects straight
-- from the CDN, bypassing the site-password gate.
--
-- ON CONFLICT DO NOTHING keeps this idempotent and leaves existing buckets
-- untouched. Note it also means this migration will NOT flip an existing
-- bucket that was hand-created as public — verify in the dashboard that both
-- buckets show public = false in existing environments.
--
-- No storage.objects policies are added on purpose: with RLS enabled and no
-- policies, anon/authenticated clients are denied by default and only the
-- service role (which bypasses RLS) can touch objects — matching how the app
-- actually accesses storage.

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('reference-images', 'reference-images', false),
  ('generated-images', 'generated-images', false)
ON CONFLICT (id) DO NOTHING;
