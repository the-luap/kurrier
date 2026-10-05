-- Fork: Supabase-imported users may have no argon2 hash yet (they log in
-- with the bcrypt hash in auth.users.encrypted_password, which the app then
-- upgrades to password_hash). Keep password_hash nullable on such installs.
-- No-op on fresh installs: there password_hash is NOT NULL as upstream defines it
-- and encrypted_password does not exist.

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'auth' AND table_name = 'users'
			AND column_name = 'encrypted_password'
	) THEN
		ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "password_hash" text;
		ALTER TABLE "auth"."users" ALTER COLUMN "password_hash" DROP NOT NULL;
	END IF;
END
$$;
