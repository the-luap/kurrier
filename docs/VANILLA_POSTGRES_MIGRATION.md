# Vanilla PostgreSQL Migration Plan

Goal: make this fork run on a normal PostgreSQL deployment without Supabase Auth, Supabase Storage, Kong, GoTrue, Realtime, or Supabase-specific service keys.

Non-goal: remove row-level security. RLS is still the right security boundary for a multi-tenant mail app. We should keep it and replace Supabase-specific helpers with application-owned PostgreSQL helpers.

## Current state

Fork repository: <https://github.com/the-luap/kurrier>

The fork currently includes Paul's local fixes on `main`:

- safer mailbox/thread routing and navigation
- reduced mailbox list prefetch/query work
- storage-tolerant IMAP ingestion
- manual sync timeout/background-status handling
- hydration-safe mailbox dates
- compose From-account selector
- single-message actions and delete UX fixes
- dark-mode body rendering fix
- close-thread optimistic UX
- per-identity email signatures persisted in `identities.signature_html`

## Supabase dependency inventory

### Database/RLS

The schema and migrations use Supabase's `auth.uid()` heavily:

- `owner_id uuid DEFAULT auth.uid() NOT NULL`
- RLS policies like `owner_id = (select auth.uid())`
- storage policies using `auth.uid()` path prefixes
- Supabase-style roles such as `authenticated`
- `drizzle-orm/supabase` auth user helpers in the worker migration plugin

Key files:

- `db/init/migrations/*.sql`
- `db/migrations/initialize-schema.sql`
- `packages/db/src/drizzle/*.sql`
- `packages/db/src/drizzle/schema.ts`
- `packages/db/src/drizzle/rls_client.sql`

### Auth/session

The web and worker apps use Supabase SSR/Auth clients:

- `apps/web/lib/supabase/server.ts`
- `apps/web/lib/supabase/client.ts`
- `apps/web/lib/supabase/middleware.ts`
- `apps/web/lib/actions/auth.ts`
- `apps/worker/lib/create-client*.ts`
- `apps/worker/server/utils/create-client.ts`
- `apps/worker/server/routes/sse.ts`
- `apps/worker/server/routes/api/v1/mailbox-search.get.ts`

### Storage

Supabase Storage is used for mail raw EML blobs, attachments, contact images, DAV assets, and inbound provider hooks.

Important call sites:

- `apps/worker/lib/message-payload-parser.ts`
- `apps/worker/server/utils/message-payload-parser.ts`
- `apps/worker/server/plugins/send-mail.ts`
- `apps/worker/server/routes/api/v1/hooks/*`
- `apps/web/components/mailbox/default/email-renderer.tsx`
- `apps/web/components/mailbox/default/editor/editor-attachment-item.tsx`
- `apps/web/components/dashboard/contacts/new-contact-form.tsx`
- `apps/web/lib/actions/calendar.ts`
- `apps/worker/lib/dav/**`

### Realtime

Realtime/channel usage appears in IMAP sync and inbound hooks:

- `apps/worker/lib/imap/imap-idle-sync.ts`
- `apps/worker/server/routes/api/v1/hooks/aws/ses/inbound.post.ts`

### Configuration/deployment

Supabase-specific env/config currently exists in Dockerfiles, compose files, docs, and schema config types:

- `DATABASE_RLS_URL`
- `SERVICE_ROLE_KEY`
- `API_URL` pointed at Supabase/Kong endpoints
- `db/docker-compose*.yml`
- `db/init/volumes/api/kong.yml`
- `apps/web/Dockerfile`
- `apps/docs/content/docs/installation.mdx`
- `packages/schema/src/types/config.ts`

## Target architecture

### PostgreSQL

Run one vanilla PostgreSQL service/container with:

- application database, e.g. `kurrier`
- `app_owner` role for migrations/admin tasks
- `app_web` role for web/worker database access
- RLS enabled on tenant-owned tables
- a small compatibility schema for replacing Supabase helpers

Recommended compatibility layer:

```sql
create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create role authenticated;
grant authenticated to app_web;
```

Then every authenticated request runs inside a transaction and sets the user context before tenant-scoped queries:

```sql
select set_config('app.current_user_id', $1, true);
select set_config('role', 'authenticated', true); -- optional; prefer SET ROLE where needed
```

Implementation note: use `SET LOCAL app.current_user_id = '<uuid>'` or `select set_config(..., true)` inside the same transaction. Do not use a global/session setting with pooled connections unless it is reset safely.

### Auth

Replace Supabase Auth with app-owned session auth:

- create `users` table or map to existing Supabase `auth.users` equivalent
- store password hashes with Argon2id
- sign app sessions/JWTs with local `SESSION_SECRET`
- store session cookie as HTTP-only, secure, same-site lax/strict
- expose server helpers:
  - `getCurrentUser()`
  - `requireUser()`
  - `withUserDb(userId, callback)`

Migration path should support importing existing Supabase Auth users if needed.

### Storage

Replace Supabase Storage with a provider abstraction:

```ts
interface ObjectStore {
  putObject(key: string, body: Blob | Buffer | ReadableStream, metadata?: Record<string, string>): Promise<void>;
  getObject(key: string): Promise<ReadableStream | Buffer>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
```

Initial provider options:

1. S3-compatible object storage via MinIO or Garage — recommended for production.
2. Filesystem storage under a mounted volume — acceptable for single-node/lab.

Keep DB metadata in existing attachment/message tables. Only replace the blob backend.

### Realtime/SSE

Replace Supabase Realtime with existing app channels:

- short-term: UI polling for sync status where already implemented
- medium-term: Server-Sent Events endpoint backed by Redis Pub/Sub
- long-term: optional Postgres `LISTEN/NOTIFY` for DB-event fanout, but Redis is simpler because BullMQ is already present

### API/Kong

Remove Kong/Supabase API routing from the required deployment. Web should call internal app/worker routes directly, not `/api/kong` as a Supabase compatibility proxy.

## Migration phases

### Phase 0 — Freeze and protect the fork

Status: mostly done.

- [x] Create fork repo: `the-luap/kurrier`
- [x] Push current `main` with local commits
- [x] Push working branch `paul/mail-ux-fixes`
- [ ] Protect `main` once CI is green
- [ ] Add CI for typecheck, lint, build, and migration smoke test
- [ ] Decide final product name/package image names

### Phase 1 — Add compatibility layer without removing Supabase yet

Purpose: reduce risk by making the existing code run unchanged against vanilla Postgres where possible.

Tasks:

1. Add a new migration `019_vanilla_postgres_compat.sql`:
   - create `auth` schema
   - create `auth.uid()` function using `current_setting('app.current_user_id')`
   - create `authenticated` role compatibility if absent
   - grant required privileges to app DB role
2. Add a DB helper in the app layer:
   - `withUserDb(userId, fn)`
   - wraps tenant-scoped queries in a transaction
   - sets `app.current_user_id` locally
3. Convert selected high-traffic server actions to use the helper first:
   - identities
   - mailboxes
   - messages/thread fetch
   - compose send
4. Build a Docker Compose profile with only:
   - Postgres
   - Redis
   - web
   - worker
   - object storage placeholder

Acceptance criteria:

- migrations apply to vanilla Postgres
- login still works in existing deployment
- mailbox list/detail queries pass RLS with `app.current_user_id`
- no RLS bypass introduced

### Phase 2 — Replace Supabase Auth

Tasks:

1. Create app-owned auth schema:
   - `users(id uuid primary key, email citext unique, password_hash text, email_verified boolean, created_at timestamptz, updated_at timestamptz)`
   - `sessions(id uuid primary key, user_id uuid references users, token_hash text, expires_at timestamptz, created_at timestamptz)` if using DB sessions
2. Replace `apps/web/lib/actions/auth.ts` with local auth:
   - sign up
   - login
   - logout
   - current user
3. Replace Supabase middleware/session refresh with local cookie/session middleware.
4. Replace `supabase.auth.getUser()` and `supabase.auth.admin.getUserById()` call sites.
5. Add migration/import script for existing users.

Acceptance criteria:

- user can sign up/log in/log out without Supabase
- server actions get the current user from local session
- worker/API routes can authenticate using local session/API keys
- RLS context is set from local session user id

### Phase 3 — Replace Supabase Storage

Tasks:

1. Add `packages/storage` or `apps/worker/lib/object-store` abstraction.
2. Implement providers:
   - `s3` provider for MinIO/Garage/AWS-compatible storage
   - `filesystem` provider for local/self-hosted small deployments
3. Replace upload/download/signed-url call sites.
4. Add migration utility from Supabase Storage paths to the new backend if existing data must be preserved.
5. Keep the previously added tolerant ingestion behavior: storage failure must not abort metadata/message ingestion.

Acceptance criteria:

- inbound IMAP messages store DB rows even if blob storage has transient failure
- attachments/raw EML can be downloaded through app-controlled signed URLs
- email rendering and editor attachments no longer instantiate Supabase clients in browser code

### Phase 4 — Replace Realtime and Supabase API routing

Tasks:

1. Replace Supabase channel notifications with Redis Pub/Sub or BullMQ events.
2. Convert SSE endpoint to local auth + Redis event fanout.
3. Remove `/api/kong` dependency from `next.config.ts` and Supabase client helpers.
4. Remove Kong, GoTrue, Supabase Realtime, Supabase Storage, and PostgREST services from compose.

Acceptance criteria:

- manual sync status and mailbox updates work without Supabase Realtime
- no runtime route depends on `/api/kong`
- compose starts only our services plus Postgres/Redis/object storage

### Phase 5 — Cleanup and hardening

Tasks:

1. Remove Supabase packages from `apps/web` and `apps/worker`.
2. Remove Supabase env vars:
   - `SERVICE_ROLE_KEY`
   - `DATABASE_RLS_URL` if replaced by context-setting helper
   - Supabase API URL assumptions
3. Update docs and generated secret tooling.
4. Add regression tests for tenant isolation:
   - user A cannot read user B identities
   - user A cannot read user B messages/attachments
   - API keys are scoped to owner
5. Add backup/restore docs for Postgres + object storage.

Acceptance criteria:

- `git grep '@supabase'` returns zero app runtime dependencies
- tenant isolation tests pass
- clean fresh install works from vanilla compose
- production migration dry-run documented

## Risk notes

- Do not remove RLS just to simplify the port. Application-only `where owner_id = ...` checks are easier to miss and will eventually leak tenant data.
- Be careful with pooled DB connections. `app.current_user_id` must be transaction-local or reset reliably.
- Browser-side direct storage access should be removed. Signed URLs should be minted by the app after auth/RLS checks.
- Existing Supabase Auth user IDs should be preserved where possible because `owner_id` references those UUIDs across the data model.
- Supabase itself has open-source components, but relying on the full Supabase stack still creates operational and pricing/packaging risk. The goal here is independence: normal Postgres + normal object storage + app-owned auth.

## Recommended execution order

1. Commit this plan.
2. Add CI to the fork.
3. Implement Phase 1 compatibility migration and DB helper.
4. Build a vanilla-compose lab environment.
5. Port auth.
6. Port storage.
7. Port realtime.
8. Remove Supabase packages/config.
9. Run tenant-isolation tests before any production migration.
