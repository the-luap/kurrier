-- Fork: free the version names 018_migration / 019_migration / 020_migration
-- that the v3-based fork recorded in public.migrations. Upstream will ship its
-- own 018_migration.sql etc. later; db-bootstrap.sh skips any file whose
-- basename is already recorded, so without this the upstream files would be
-- silently skipped on the deployed database.
--
-- Named 000_* so it sorts before every upstream NNN_migration.sql under both
-- C and en_US.UTF-8 collation (the migrate container runs `ls | sort`).
-- Each row is only removed when the fork object it stands for is present, so
-- an upstream 0NN_migration that was genuinely applied is never touched.
-- The fork objects themselves are (re)handled idempotently by fork_*.sql.
--
-- Every DELETE is also guarded by "this file has not been recorded yet":
-- db-bootstrap.sh records it right after the first run, so a later manual
-- re-run (psql -f) can never delete a genuine upstream 018-020 record.

DELETE FROM public.migrations
WHERE version = '018_migration'
  AND NOT EXISTS (SELECT 1 FROM public.migrations WHERE version = '000_fork_reclaim_legacy_versions')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'identities'
      AND column_name = 'signature_html'
  );

DELETE FROM public.migrations
WHERE version = '019_migration'
  AND NOT EXISTS (SELECT 1 FROM public.migrations WHERE version = '000_fork_reclaim_legacy_versions')
  AND to_regclass('public.user_ai_settings') IS NOT NULL;

DELETE FROM public.migrations
WHERE version = '020_migration'
  AND NOT EXISTS (SELECT 1 FROM public.migrations WHERE version = '000_fork_reclaim_legacy_versions')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
      AND column_name = 'password_hash' AND is_nullable = 'YES'
  );
