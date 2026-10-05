# Fork database migrations

This fork runs upstream Kurrier (v4.3) plus a few database objects of its own.
The fork's SQL files sit next to upstream's in `db/init/migrations/` and are
applied by the same `db/init/db-bootstrap.sh` (the `migrate` container).

## How the bootstrap runs files

`db-bootstrap.sh` runs `ls /scripts/migrations/*.sql | sort`. For each file it
checks `public.migrations` for the basename without `.sql`. If the basename is
recorded, the file is skipped. Otherwise the file runs with `psql -v ON_ERROR_STOP=1`
and the basename is recorded. A failing file stops the whole run, and nothing is
recorded for it.

## Naming scheme

| File | Sorts | Purpose |
|---|---|---|
| `000_fork_reclaim_legacy_versions.sql` | before every upstream file | one-time cleanup of version names used by the old v3 fork |
| `NNN_migration.sql` | numeric | upstream, never edited by the fork |
| `fork_NNN_<desc>.sql` | after every numeric file | fork objects |

Digits sort before letters in the `C`/`POSIX` locale and in `en_US.UTF-8`.
The `postgres:18` image sets `LANG=en_US.utf8`; both collations were checked.
So:

- `fork_*` files always run after all upstream files of the same release. They
  can therefore depend on upstream tables such as `email_signatures`.
- `fork_*` basenames can never collide with an upstream basename.

Rules for new fork migrations:

- Use the next free `fork_NNN_` number. Never rename or edit a fork file once
  it has been deployed; add a new one.
- Every fork file must be idempotent. It must also be safe to re-run by hand
  with `psql -f`, using `IF NOT EXISTS`, guarded `DO` blocks and similar.
- Do not use `CREATE INDEX CONCURRENTLY`. A failed concurrent build leaves an
  INVALID index that `IF NOT EXISTS` would skip on the next run.

When upstream ships a new release, its new `0NN_migration.sql` files run first
and the fork files that are already recorded are skipped. If an upstream
release adds an object that a fork file also creates (for example AI settings
or the same index), resolve it in a new `fork_NNN` file. Do not edit the old one.

## What each fork migration does

### `000_fork_reclaim_legacy_versions.sql`

The v3-based fork (`paul/mail-ux-fixes`) shipped `018_migration.sql`,
`019_migration.sql` and `020_migration.sql`, and the deployed database recorded
those names. Upstream will eventually ship its own `018_migration.sql`–`020_migration.sql`,
and the bootstrap would skip them silently. This file deletes those three rows
from `public.migrations`, under two conditions:

- the matching fork object exists:
  - 018: the column `identities.signature_html`;
  - 019: the table `user_ai_settings`;
  - 020: `auth.users.password_hash` is nullable.
- `000_fork_reclaim_legacy_versions` itself is not yet recorded. This makes a
  later manual re-run a no-op, so it can never delete a genuine upstream record.

The objects themselves are handled by the `fork_*` files below. It is a no-op
on fresh installs.

### `fork_001_user_ai_settings.sql`

This file manages the per-user AI provider settings (Ollama / LM Studio) table
`user_ai_settings`. On a fresh install it creates the table. On the deployed v3
database it converts the existing Supabase-style table in place:

- **Columns:**
  - It adds `workspace_id`, `api_key` and `api_key_secret_id` if they are missing.
  - The `owner_id` and `workspace_id` defaults come from the
    `request.jwt.claim.sub` / `request.jwt.claim.workspace_id` claims. `auth.uid()`
    is no longer used.
  - The `base_url` default is `http://localhost:11434`, and `enabled` defaults to `false`.
- **Backfill:** `workspace_id` is set to the user's oldest owned workspace, or
  else to the oldest membership. Rows of users without any workspace are deleted,
  because they would be unreachable. Then `workspace_id` becomes NOT NULL.
- **Foreign keys:**
  - `owner_id` → `auth.users` and `workspace_id` → `workspaces`, both `ON DELETE CASCADE`.
  - `api_key_secret_id` → `secrets_meta`, `ON DELETE SET NULL`.
- **Uniqueness:** `(workspace_id, owner_id, provider)` replaces the old `(owner_id, provider)`.
- **RLS:**
  - All existing policies on the table are dropped, including the old `TO authenticated` ones.
  - Four policies `TO kurrier` are created (select, insert, update, delete). Each requires
    `workspace_id = claim.workspace_id AND owner_id = claim.sub`. The settings are
    private to the user inside the workspace, so this is stricter than
    upstream's `workspaceCrudPolicies`.
  - `GRANT SELECT, INSERT, UPDATE, DELETE` to `kurrier`.
- **Atomicity:** the file runs in one transaction.

**API key storage.** Keys belong in upstream's vault. That is `secrets_meta`,
encrypted with AES-256-GCM by the app using `APP_SECRET_ENCRYPTION_KEY`, through
`createSecret(session, workspaceId, { name, value, managedBy: "system" })`.
Secrets with `managedBy: "system"` are hidden from the vault UI. Store the
returned id in `api_key_secret_id`. Upstream's `secrets_meta` is unique per
`(workspace_id, name)`, so use a name such as `ai:<ownerId>:<provider>`.

`api_key` (plaintext) only exists for rows carried over from the v3 fork. SQL
cannot encrypt it because the key lives in the app. On the next save, the app
should move a non-null `api_key` into the vault and set `api_key` to NULL. A
later `fork_NNN` can drop the column.

Drizzle: `userAiSettings` is in `packages/db/src/drizzle/schema.ts`. The types
`UserAiSettingsEntity`, `UserAiSettingsCreate` and `UserAiSettingsUpdate` are
in `drizzle-types.ts`. An upsert must target `(workspaceId, ownerId, provider)`.

### `fork_002_signatures_from_identities.sql`

This file moves the v3 fork's per-identity signature (`identities.signature_html`)
into upstream's `email_signatures`, which comes from upstream `009_migration`.
It is a no-op when the column does not exist.

- For each identity with non-empty `signature_html`, it inserts one row named
  `Signature`. `workspace_id` and `owner_id` are copied from the identity, and
  `meta = {"migratedFrom": "identities.signature_html"}`.
- `document` is an EmailDocument v1 with upstream's default settings and a
  single `text` block whose `content` is the old HTML. Upstream renders
  text-block content as HTML.
- `is_default_for_new` and `is_default_for_reply_forward` are set only if the
  identity has no such default yet. This respects the partial unique indexes
  `ux_email_signatures_default_new` and `ux_email_signatures_default_reply_forward`.
- `ON CONFLICT (identity_id, name) DO NOTHING` applies, and identities that
  already have a migrated row are skipped. A manual re-run therefore never
  duplicates a signature, and it never re-creates one the user has edited or renamed.
- The `identities.signature_html` column is **kept**. Drop it in a later
  `fork_NNN` once the migrated signatures have been checked.

### `fork_003_auth_users_legacy.sql`

This is for users imported from Supabase, who only have a bcrypt
`encrypted_password`. If `auth.users.encrypted_password` exists, the file keeps
`password_hash` nullable, so such users can log in once and be re-hashed. This
only matters if the app keeps the legacy-login code path. Otherwise it is a
no-op: on a fresh install `password_hash` stays NOT NULL.

### `fork_004_indexes.sql`

These are the fork's performance indexes, adapted to v4's workspace-based RLS.
They are mirrored in `schema.ts`.

- `ix_messages_workspace_created` on `messages(workspace_id, created_at)`: dashboard message counts.
- `ix_mbth_workspace_snoozed_until` on `mailbox_threads(workspace_id, snoozed_until) WHERE snoozed_until IS NOT NULL`: account-wide snoozed view.
- `ix_calendar_events_workspace_ical_uid` on `calendar_events(workspace_id, ical_uid) WHERE ical_uid IS NOT NULL`: invitation lookup by UID across calendars.

### `fork_005_draft_messages_indexes.sql`

Composite indexes for the draft queries of the ports, mirrored in `schema.ts`.

- `ix_draft_messages_owner_status_updated` on `draft_messages(owner_id, status, updated_at)`: autosaved drafts of a user, newest first.
- `ix_draft_messages_workspace_status` on `draft_messages(workspace_id, status)`: RLS filter plus the scheduled / draft counts.
- `ix_draft_messages_identity_status` on `draft_messages(identity_id, status)`: scheduled sends of one identity.

### `fork_006_message_lookup_indexes.sql`

Indexes for the per-message lookups of the IMAP sync worker, mirrored in
`schema.ts`. Plain `CREATE INDEX`: on a large `messages` table writes to it
wait while the indexes build.

- `ix_messages_owner_message_id` on `messages(owner_id, message_id)`: delta sync looks up every fetched envelope, and thread assignment every In-Reply-To / References id, by owner and Message-ID.
- `ix_messages_mailbox_imap_uid` on `messages(mailbox_id, ((meta->'imap'->>'uid')::bigint))`: IDLE flag / expunge events resolve the message by mailbox and IMAP UID.

## Upgrading the deployed (v3 fork) database

The deployed database is upstream v3.0.11 (`001`–`003`) plus the fork's
`018`/`019`/`020`. `019` needs `auth.uid()` and the `authenticated` role. On a
pure v3 database it fails with `function auth.uid() does not exist`, the
bootstrap stops there, and `020` never runs. Both outcomes are handled.

### 1. Diagnostics (run before deploying)

```sql
-- which versions are recorded (expect 001-003, 018, maybe 019/020)
SELECT version, applied_at FROM public.migrations ORDER BY applied_at;

-- does the old AI table exist? (NULL = 019 never succeeded)
SELECT to_regclass('public.user_ai_settings');

-- Supabase leftovers that 019 relied on
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'auth';
SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon', 'service_role', 'kurrier');

-- auth.users: is encrypted_password present? is password_hash nullable?
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema = 'auth' AND table_name = 'users' AND column_name IN ('password_hash', 'encrypted_password');

-- users who still have no argon2 hash (decides whether legacy login is needed)
SELECT count(*) FROM auth.users WHERE password_hash IS NULL;

-- signatures that fork_002 will migrate
SELECT count(*) FROM identities WHERE coalesce(btrim(signature_html), '') <> '';

-- AI rows (if the table exists) and whether each user has a workspace
SELECT s.owner_id, s.provider, (s.api_key IS NOT NULL) AS has_key,
       EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = s.owner_id)
    OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = s.owner_id) AS has_workspace
FROM user_ai_settings s;
```

Things to look at in the results:

- A version other than `001`–`003` and `018`–`020` in `public.migrations` (for
  example Supabase-era names): stop and investigate before deploying.
- `has_workspace = false`: `fork_001` deletes that row.
- `password_hash IS NULL` count is greater than 0: those users can only log in
  if the legacy bcrypt login path is ported. If it is 0, that code is not needed.

### 2. Deploy

1. Take a backup: `pg_dump -Fc`.
2. Deploy v4.3 with this `db/init/migrations` directory. It must **not**
   contain the old fork files `018_migration.sql`, `019_migration.sql` or
   `020_migration.sql`.
3. The bootstrap runs `000_fork_…`, skips `001`–`003`, runs upstream `004`–`011`,
   then `fork_001`…`fork_006`.
4. Check the result:
   ```sql
   SELECT version FROM public.migrations ORDER BY 1;  -- 000_fork…, 001–011, fork_001–fork_006
   SELECT policyname, roles FROM pg_policies WHERE tablename = 'user_ai_settings';
   SELECT identity_id, name, is_default_for_new, is_default_for_reply_forward
   FROM email_signatures WHERE meta->>'migratedFrom' = 'identities.signature_html';
   ```

### Optional cleanup later

These are separate `fork_NNN` files, written only when nothing uses the objects
any more:

- Drop the `auth.uid()` shim and the `authenticated` role.
- Drop `identities.signature_html`.
- Drop `user_ai_settings.api_key` once every key is in the vault.
- Restore `auth.users.password_hash` to NOT NULL, if no user still has a NULL hash.
