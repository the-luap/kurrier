import { currentSession } from "@/lib/actions/auth";
import { createDrizzleSupabaseClient } from "@db";
import type { AuthSession } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

const requireSession = (session: AuthSession | null): AuthSession => {
	if (!session) {
		redirect("/auth/login");
	}
	return session;
};

export const rlsClient = async () => {
	const session = requireSession(await currentSession());
	const { rls } = await createDrizzleSupabaseClient(session);
	return rls;
};

export const adminClient = async () => {
	const session = requireSession(await currentSession());
	const { admin } = await createDrizzleSupabaseClient(session);
	return admin;
};
