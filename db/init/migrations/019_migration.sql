CREATE TABLE "user_ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid DEFAULT auth.uid() NOT NULL,
	"provider" text DEFAULT 'ollama' NOT NULL,
	"base_url" text DEFAULT 'http://10.0.252.12:11434' NOT NULL,
	"model" text DEFAULT 'gemma3:12b' NOT NULL,
	"system_prompt" text,
	"temperature" numeric(4, 2) DEFAULT '0.4' NOT NULL,
	"max_tokens" integer DEFAULT 700 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_ai_settings_owner_provider" ON "user_ai_settings" USING btree ("owner_id","provider");
--> statement-breakpoint
ALTER TABLE "user_ai_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_ai_settings_select_own" ON "user_ai_settings" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("user_ai_settings"."owner_id" = auth.uid());
--> statement-breakpoint
CREATE POLICY "user_ai_settings_insert_own" ON "user_ai_settings" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("user_ai_settings"."owner_id" = auth.uid());
--> statement-breakpoint
CREATE POLICY "user_ai_settings_update_own" ON "user_ai_settings" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("user_ai_settings"."owner_id" = auth.uid()) WITH CHECK ("user_ai_settings"."owner_id" = auth.uid());
