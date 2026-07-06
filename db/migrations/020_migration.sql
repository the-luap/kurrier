ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "password_hash" text;--> statement-breakpoint
ALTER TABLE "auth"."users" ALTER COLUMN "password_hash" DROP NOT NULL;
