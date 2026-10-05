"use server";

import * as crypto from "node:crypto";
import { APP_VERSION } from "@common";
import { decode } from "@db";
import { type FormState, getPublicEnv } from "@schema";
import type { AuthSession } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { addJobAndWait } from "@/lib/actions/get-redis";
import { createClient } from "@/lib/supabase/server";
import { formDataToJson } from "@/lib/utils";

const initProviders = async (userId: string) => {
	await addJobAndWait("common-worker", "sync-providers", { userId });
};

export async function login(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const values = formDataToJson(formData);
	const supabase = await createClient();
	const { data, error } = await supabase.auth.signInWithPassword({
		email: values.email,
		password: values.password,
	});

	if (error) {
		return {
			success: false,
			error: error.message,
		};
	}

	if (data) {
		redirect("/dashboard/platform/overview");
	}

	return { success: true, message: "Logged in!" };
}

const applyPendingMigrations = async (userId: string) => {
	await addJobAndWait(
		"migration-worker",
		"migration:run-for-user-after-signup",
		{ userId },
		{
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 3000,
			},
			removeOnComplete: { age: 60 },
			removeOnFail: false,
			jobId: `migration:${userId}:${APP_VERSION}`,
		},
	);
};

export async function signup(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	// Check if signup is disabled
	const { DISABLE_SIGNUP } = getPublicEnv();
	if (DISABLE_SIGNUP) {
		return {
			success: false,
			error: "Signup is currently disabled. Please contact your administrator.",
		};
	}

	const values = formDataToJson(formData);
	const supabase = await createClient();
	const { data, error } = await supabase.auth.signUp({
		email: values.email,
		password: values.password,
	});

	if (error) {
		return {
			success: false,
			error: error.message,
		};
	}

	const userId = String(data?.user?.id);
	await initProviders(userId);
	await applyPendingMigrations(userId);

	if (data) {
		redirect("/dashboard/platform/overview");
	}

	return { success: true, message: "Welcome!", data };
}

export const isSignedIn = cache(async () => {
	const client = await createClient();
	try {
		const {
			data: { user },
		} = await client.auth.getUser();
		return user;
	} catch (error) {
		console.warn("Unable to load authenticated user", error);
		return null;
	}
});

export const currentSession = cache(async (): Promise<AuthSession | null> => {
	const client = await createClient();
	try {
		const {
			data: { session },
		} = await client.auth.getSession();
		if (!session?.access_token) return null;

		// getSession() only reads the cookie and does not verify the JWT
		// signature. The token's claims are used for RLS, so make sure the
		// auth server accepts it (getUser is cached per request) and that it
		// belongs to that user.
		const user = await isSignedIn();
		const claims = decode(session.access_token);
		if (!user || claims.sub !== user.id) return null;

		return session as AuthSession | null;
	} catch (error) {
		console.warn("Unable to load auth session", error);
		return null;
	}
});

export const signOut = async (redirectUrl?: string) => {
	const client = await createClient();
	await client.auth.signOut();
	redirect(redirectUrl ? redirectUrl : "/auth/login");
};

export const getGravatarUrl = async (email: string, size = 80) => {
	const trimmedEmail = email.trim().toLowerCase();
	const hash = crypto.createHash("sha256").update(trimmedEmail).digest("hex");
	return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
};
