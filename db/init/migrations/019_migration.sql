-- 019: per-user AI settings (idempotent; safe on DBs where an earlier
-- version of this migration was applied manually).

CREATE TABLE IF NOT EXISTS "user_ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid DEFAULT auth.uid() NOT NULL,
	"provider" text DEFAULT 'ollama' NOT NULL,
	"base_url" text DEFAULT 'http://localhost:11434' NOT NULL,
	"model" text DEFAULT 'gemma3:12b' NOT NULL,
	"api_key" text,
	"system_prompt" text,
	"temperature" numeric(4, 2) DEFAULT '0.4' NOT NULL,
	"max_tokens" integer DEFAULT 700 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "user_ai_settings" ADD COLUMN IF NOT EXISTS "api_key" text;

-- Older manual versions used a private LAN default and enabled AI by default.
ALTER TABLE "user_ai_settings" ALTER COLUMN "base_url" SET DEFAULT 'http://localhost:11434';
ALTER TABLE "user_ai_settings" ALTER COLUMN "enabled" SET DEFAULT false;

-- Owner FK with ON DELETE CASCADE (replace a pre-existing NO ACTION FK).
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'user_ai_settings_owner_id_users_id_fk'
			AND conrelid = 'public.user_ai_settings'::regclass
			AND confdeltype <> 'c'
	) THEN
		ALTER TABLE "user_ai_settings" DROP CONSTRAINT "user_ai_settings_owner_id_users_id_fk";
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'user_ai_settings_owner_id_users_id_fk'
			AND conrelid = 'public.user_ai_settings'::regclass
	) THEN
		ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_ai_settings_owner_provider" ON "user_ai_settings" USING btree ("owner_id","provider");

ALTER TABLE "user_ai_settings" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_ai_settings_select_own" ON "user_ai_settings";
CREATE POLICY "user_ai_settings_select_own" ON "user_ai_settings" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("user_ai_settings"."owner_id" = (select auth.uid()));

DROP POLICY IF EXISTS "user_ai_settings_insert_own" ON "user_ai_settings";
CREATE POLICY "user_ai_settings_insert_own" ON "user_ai_settings" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("user_ai_settings"."owner_id" = (select auth.uid()));

DROP POLICY IF EXISTS "user_ai_settings_update_own" ON "user_ai_settings";
CREATE POLICY "user_ai_settings_update_own" ON "user_ai_settings" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("user_ai_settings"."owner_id" = (select auth.uid())) WITH CHECK ("user_ai_settings"."owner_id" = (select auth.uid()));

DROP POLICY IF EXISTS "user_ai_settings_delete_own" ON "user_ai_settings";
CREATE POLICY "user_ai_settings_delete_own" ON "user_ai_settings" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("user_ai_settings"."owner_id" = (select auth.uid()));
