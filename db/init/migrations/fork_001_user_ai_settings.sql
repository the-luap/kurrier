-- Fork: per-user AI provider settings (Ollama / LM Studio) on the upstream v4
-- RLS model: role "kurrier", claims request.jwt.claim.sub and
-- request.jwt.claim.workspace_id (same as every upstream table).
--
-- Idempotent. Two starting points:
--   * fresh install: the table does not exist and is created here;
--   * deployed v3 fork: the table came from the old fork 019_migration
--     (auth.uid() default, policies TO authenticated, no workspace_id,
--     maybe no api_key) and is converted in place.
--
-- API key storage: the key belongs in upstream's encrypted vault
-- (secrets_meta, AES-256-GCM, encrypted by the app with
-- APP_SECRET_ENCRYPTION_KEY). Store it with createSecret(..., managedBy
-- "system") and keep the reference in api_key_secret_id. The plaintext
-- column api_key is kept only for rows carried over from the v3 fork; SQL
-- cannot encrypt it (the key lives in the app), so the app should move a
-- non-null api_key into the vault on the next save and set api_key to NULL.

BEGIN;

CREATE TABLE IF NOT EXISTS "user_ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid NOT NULL,
	"owner_id" uuid DEFAULT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid NOT NULL,
	"provider" text DEFAULT 'ollama' NOT NULL,
	"base_url" text DEFAULT 'http://localhost:11434' NOT NULL,
	"model" text DEFAULT 'gemma3:12b' NOT NULL,
	"api_key" text,
	"api_key_secret_id" uuid,
	"system_prompt" text,
	"temperature" numeric(4, 2) DEFAULT '0.4' NOT NULL,
	"max_tokens" integer DEFAULT 700 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "user_ai_settings" ADD COLUMN IF NOT EXISTS "api_key" text;
ALTER TABLE "user_ai_settings" ADD COLUMN IF NOT EXISTS "api_key_secret_id" uuid;
ALTER TABLE "user_ai_settings" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;

-- Replace the Supabase-era auth.uid() default and the LAN-specific defaults.
ALTER TABLE "user_ai_settings" ALTER COLUMN "owner_id"
	SET DEFAULT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
ALTER TABLE "user_ai_settings" ALTER COLUMN "workspace_id"
	SET DEFAULT nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid;
ALTER TABLE "user_ai_settings" ALTER COLUMN "base_url" SET DEFAULT 'http://localhost:11434';
ALTER TABLE "user_ai_settings" ALTER COLUMN "enabled" SET DEFAULT false;

-- Backfill workspace_id for v3-fork rows: the user's oldest owned workspace,
-- else the oldest membership.
UPDATE "user_ai_settings" s
SET "workspace_id" = (
	SELECT w.id FROM "workspaces" w
	WHERE w.owner_id = s.owner_id
	ORDER BY w.created_at
	LIMIT 1
)
WHERE s.workspace_id IS NULL;

UPDATE "user_ai_settings" s
SET "workspace_id" = (
	SELECT m.workspace_id FROM "workspace_members" m
	WHERE m.user_id = s.owner_id
	ORDER BY m.created_at
	LIMIT 1
)
WHERE s.workspace_id IS NULL;

-- Rows of users without any workspace are unreachable under the new
-- policies; drop them instead of blocking NOT NULL.
DELETE FROM "user_ai_settings" WHERE "workspace_id" IS NULL;
ALTER TABLE "user_ai_settings" ALTER COLUMN "workspace_id" SET NOT NULL;

-- Foreign keys (dropped and re-added so the old NO ACTION owner FK becomes CASCADE).
ALTER TABLE "user_ai_settings" DROP CONSTRAINT IF EXISTS "user_ai_settings_owner_id_users_id_fk";
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_owner_id_users_id_fk"
	FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_ai_settings" DROP CONSTRAINT IF EXISTS "user_ai_settings_workspace_id_workspaces_id_fk";
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_ai_settings" DROP CONSTRAINT IF EXISTS "user_ai_settings_api_key_secret_id_secrets_meta_id_fk";
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_api_key_secret_id_secrets_meta_id_fk"
	FOREIGN KEY ("api_key_secret_id") REFERENCES "public"."secrets_meta"("id") ON DELETE set null ON UPDATE no action;

-- One row per (workspace, user, provider); replaces the v3 (owner, provider) index.
DROP INDEX IF EXISTS "uniq_user_ai_settings_owner_provider";
CREATE UNIQUE INDEX IF NOT EXISTS "ux_user_ai_settings_workspace_owner_provider"
	ON "user_ai_settings" USING btree ("workspace_id", "owner_id", "provider");
CREATE INDEX IF NOT EXISTS "ix_user_ai_settings_owner" ON "user_ai_settings" USING btree ("owner_id");
CREATE INDEX IF NOT EXISTS "ix_user_ai_settings_api_key_secret" ON "user_ai_settings" USING btree ("api_key_secret_id");

-- RLS: drop every existing policy (the v3 fork had TO authenticated / auth.uid()
-- policies, possibly under other names) and recreate the v4-style ones.
ALTER TABLE "user_ai_settings" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
	p record;
BEGIN
	FOR p IN
		SELECT policyname FROM pg_policies
		WHERE schemaname = 'public' AND tablename = 'user_ai_settings'
	LOOP
		EXECUTE format('DROP POLICY %I ON "public"."user_ai_settings"', p.policyname);
	END LOOP;
END
$$;

CREATE POLICY "user_ai_settings_select_own" ON "user_ai_settings" AS PERMISSIVE FOR SELECT TO "kurrier"
	USING (
		"user_ai_settings"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
		AND "user_ai_settings"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
	);
CREATE POLICY "user_ai_settings_insert_own" ON "user_ai_settings" AS PERMISSIVE FOR INSERT TO "kurrier"
	WITH CHECK (
		"user_ai_settings"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
		AND "user_ai_settings"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
	);
CREATE POLICY "user_ai_settings_update_own" ON "user_ai_settings" AS PERMISSIVE FOR UPDATE TO "kurrier"
	USING (
		"user_ai_settings"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
		AND "user_ai_settings"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
	)
	WITH CHECK (
		"user_ai_settings"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
		AND "user_ai_settings"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
	);
CREATE POLICY "user_ai_settings_delete_own" ON "user_ai_settings" AS PERMISSIVE FOR DELETE TO "kurrier"
	USING (
		"user_ai_settings"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
		AND "user_ai_settings"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
	);

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_ai_settings" TO "kurrier";

COMMIT;
