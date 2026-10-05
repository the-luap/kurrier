"use server";

import * as crypto from "node:crypto";
import { db, identities, users } from "@db";
import { type FormState, getPublicEnv, handleAction } from "@schema";
import argon2 from "argon2";
import bcrypt from "bcryptjs";
import { decode } from "decode-formdata";
import { eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { DISTRIBUTION_CONFIG } from "@distribution/config";
import {
	createUserWithWorkspace,
	findLandingWorkspace,
	normalizeEmail,
	SESSION_COOKIE,
	signInUserAndRedirect,
	type TokenClaims as SessionTokenClaims,
	verifyAndDecode,
} from "@/lib/auth-session";

// Every export of this "use server" module is a public endpoint. Session,
// account and redirect primitives that take user ids live in
// lib/auth-session.ts (server-only) and must not be re-exported here.

/**
 * Users imported from the old Supabase-based fork have no argon2 hash yet,
 * only GoTrue's bcrypt hash in auth.users.encrypted_password. Verify that
 * once and store an argon2 hash, so the next login takes the normal path.
 */
async function verifyLegacySupabasePassword(userId: string, password: string) {
	let encryptedPassword: string | null | undefined;
	try {
		const rows = (await db.execute(sql`
			select encrypted_password
			from auth.users
			where id = ${userId} and encrypted_password is not null
			limit 1
		`)) as unknown as Array<{ encrypted_password: string | null }>;
		encryptedPassword = rows[0]?.encrypted_password;
	} catch (error) {
		// Installations that never ran on Supabase have no such column.
		if (
			error instanceof Error &&
			/encrypted_password.*does not exist/i.test(
				`${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`,
			)
		) {
			return false;
		}
		throw error;
	}

	if (!encryptedPassword) return false;
	if (!(await bcrypt.compare(password, encryptedPassword))) return false;

	await db
		.update(users)
		.set({ passwordHash: await argon2.hash(password) })
		.where(eq(users.id, userId));
	return true;
}

let dummyHash: Promise<string> | null = null;
const getDummyHash = () => {
	dummyHash ??= argon2.hash(crypto.randomUUID());
	return dummyHash;
};

export async function login(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	if (!DISTRIBUTION_CONFIG.features.localLogin) {
		return {
			success: false,
			error: "auth.localLoginDisabled",
		};
	}

	const { email: rawEmail, password, locale } = decode(formData) as {
		email: string;
		password: string;
		locale?: string;
	};
	const email = normalizeEmail(rawEmail);

	if (!email || !password) {
		return { error: "auth.missingCredentials" };
	}

	// Exact match first (index), then a case-insensitive match for accounts
	// created before emails were normalized.
	let [user] = await db.select().from(users).where(eq(users.email, email));
	if (!user) {
		[user] = await db
			.select()
			.from(users)
			.where(sql`lower(${users.email}) = ${email}`)
			.limit(1);
	}

	if (!user) {
		// Same work as a real check, so response timing does not reveal
		// which emails have an account.
		await argon2.verify(await getDummyHash(), password).catch(() => false);
		return { error: "auth.invalidCredentials" };
	}

	const valid = user.passwordHash
		? await argon2.verify(user.passwordHash, password)
		: await verifyLegacySupabasePassword(user.id, password);

	if (!valid) {
		return { error: "auth.invalidCredentials" };
	}

	await signInUserAndRedirect(user, locale);

	return { success: true, message: "auth.loggedIn" };
}

export async function signup(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const { DISABLE_SIGNUP } = getPublicEnv();

		if (DISABLE_SIGNUP) {
			return {
				success: false,
				error: "auth.signupDisabled",
			};
		}

		const { workspaceName, email, password, locale } = decode(formData) as {
			email: string;
			password: string;
			workspaceName: string;
			locale?: string;
		};

		if (!email || !password) {
			return { error: "auth.missingCredentials" };
		}

		const passwordHash = await argon2.hash(password);

		const user = await createUserWithWorkspace({
			email,
			passwordHash,
			workspaceName,
		});

		if ("error" in user) {
			return { error: user.error };
		}

		await signInUserAndRedirect(user, locale);

		return { success: true, message: "auth.welcome" };

	})

}

export type TokenClaims = SessionTokenClaims;

// Deduplicated per request: every rlsClient() call used to verify the JWT
// and select the user again.
const isSignedInCached = cache(async () => {
	const cookieStore = await cookies();
	const token = cookieStore.get(SESSION_COOKIE)?.value;

	if (!token) {
		return null;
	}

	const claims = await verifyAndDecode(token);

	if (!claims?.sub) {
		return null;
	}

	const [user] = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(eq(users.id, claims.sub));

	if (!user) {
		return null;
	}

	return user;
});

export async function isSignedIn() {
	return isSignedInCached();
}

export type FetchIsSignedInResult = Awaited<ReturnType<typeof isSignedIn>>;

export const signOut = async (redirectUrl?: string) => {
	const cookieStore = await cookies();
	cookieStore.delete(SESSION_COOKIE);
	// Same-origin paths only: the argument is caller controlled.
	const target =
		typeof redirectUrl === "string" &&
		redirectUrl.startsWith("/") &&
		!redirectUrl.startsWith("//") &&
		!redirectUrl.startsWith("/\\")
			? redirectUrl
			: "/auth/login";
	redirect(target);
};

export const getGravatarUrl = async (email: string, size = 80) => {
	const trimmedEmail = String(email ?? "").trim().toLowerCase();
	const hash = crypto.createHash("sha256").update(trimmedEmail).digest("hex");
	const px = Math.min(512, Math.max(1, Math.floor(Number(size) || 80)));
	return `https://www.gravatar.com/avatar/${hash}?s=${px}&d=identicon`;
};

/**
 * Read-only counterpart to getWorkspaceRedirectUrl: same target resolution,
 * but never writes the workspace-context cookies (that's only legal from a
 * Server Action or Route Handler). Safe to call from a plain page/layout
 * render to figure out where to redirect an already-signed-in user.
 */
export async function getDefaultWorkspacePath(user: { id: string }) {
	// Public endpoint: only ever resolve the signed-in user's own workspace.
	const me = await isSignedIn();
	if (!me?.id || String(user?.id) !== me.id) {
		return "/auth/login";
	}
	const workspace = await findLandingWorkspace(me.id);

	if (!workspace) {
		return "/auth/login";
	}

	if (workspace.defaultIdentityId) {
		const [defaultIdentity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, workspace.defaultIdentityId));

		if (defaultIdentity) {
			return `/w/${workspace.publicId}/dashboard/mail/${defaultIdentity.publicId}/inbox`;
		}
	}

	return `/w/${workspace.publicId}/dashboard/platform/overview`;
}
