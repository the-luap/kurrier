import { createDrizzleSupabaseClient } from "@db";
import type { AuthSession } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { currentSession } from "@/lib/actions/auth";

const requireSession = (session: AuthSession | null): AuthSession => {
	if (!session) {
		redirect("/auth/login");
	}
	return session;
};

export const rlsClient = cache(async () => {
	const session = requireSession(await currentSession());
	const { rls } = await createDrizzleSupabaseClient(session);
	return rls;
});

export const adminClient = cache(async () => {
	const session = requireSession(await currentSession());
	const { admin } = await createDrizzleSupabaseClient(session);
	return admin;
});
