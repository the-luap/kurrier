// Session and account primitives. Deliberately NOT a "use server" module:
// every export of a "use server" file is a public endpoint, and these take
// arbitrary user ids / password hashes (account takeover, signup bypass).
// Only server code (server actions, route handlers) may import this.
import "server-only";

import { APP_VERSION } from "@common";
import { db, identities, users, workspaceMembers, workspaces } from "@db";
import { getServerEnv } from "@schema";
import { asc, eq, sql } from "drizzle-orm";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getQueue } from "@/lib/actions/get-redis";
import { setWorkspaceContextCookies } from "@/lib/workspace-context";
import { withLocale } from "@/lib/utils";
import { hasLocale } from "@/lib/locale";
import { kurrierServer } from "@distribution/kurrier-server";

export const SESSION_COOKIE = "session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type TokenClaims = JWTPayload & {
	sub: string;
	workspace_id?: string;
};

/** Emails are stored and looked up lower-cased and trimmed. */
export const normalizeEmail = (email: string) =>
	String(email ?? "")
		.trim()
		.toLowerCase();

const initProviders = async (userId: string, workspaceId: string) => {
	// Shared per-process queue: a new Queue + QueueEvents per signup leaked
	// two Redis connections each time.
	await getQueue("common-worker").add(
		"sync-providers",
		{ userId, workspaceId },
		{ removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
	);
};

const createUserWorkspace = async (userId: string, name?: string) => {
	await kurrierServer.hooks.run("workspace.beforeCreate", {
		userId,
	});
	const [workspace] = await db
		.insert(workspaces)
		.values({
			name: String(name ?? "").trim().slice(0, 200) || "Default Workspace",
			ownerId: userId,
			storageBytesUsed: 0,
		})
		.returning();

	return workspace;
};

const applyPendingMigrations = async (
	userId: string,
	workspaceId: string,
	email: string,
) => {
	await getQueue("migration-worker").add(
		"migration:run-for-user-after-signup",
		{ userId, workspaceId, email },
		{
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 3000,
			},
			removeOnComplete: { age: 60 },
			// Deterministic jobId: a kept failed job would block the retry on
			// the next sign-in.
			removeOnFail: true,
			jobId: `migration:${userId}:${APP_VERSION}`,
		},
	);
};

export async function createUserWithWorkspace(opts: {
	email: string;
	passwordHash: string;
	workspaceName?: string;
}) {
	const email = normalizeEmail(opts.email);
	const [existing] = await db
		.select()
		.from(users)
		.where(sql`lower(${users.email}) = ${email}`)
		.limit(1);

	if (existing) {
		return { error: "auth.accountAlreadyExists" };
	}

	const [user] = await db
		.insert(users)
		.values({
			email,
			passwordHash: opts.passwordHash,
		})
		.returning();

	const workspace = await createUserWorkspace(user.id, opts.workspaceName);

	await db
		.insert(workspaceMembers)
		.values({
			workspaceId: workspace.id,
			userId: user.id,
			role: "owner",
		})
		.onConflictDoNothing();

	await initProviders(user.id, workspace.id);
	await applyPendingMigrations(user.id, workspace.id, email);

	return user;
}

async function signToken(userId: string) {
	const { JWT_SECRET } = getServerEnv();

	return new SignJWT({})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(userId)
		.setIssuedAt()
		.setExpirationTime("30d")
		.sign(new TextEncoder().encode(JWT_SECRET));
}

export async function verifyAndDecode(
	token?: string,
): Promise<TokenClaims | null> {
	if (!token) return null;

	try {
		const { JWT_SECRET } = getServerEnv();
		const { payload } = await jwtVerify<TokenClaims>(
			token,
			new TextEncoder().encode(JWT_SECRET),
			// Pin the algorithm the tokens are signed with.
			{ algorithms: ["HS256"] },
		);

		if (!payload.sub || typeof payload.sub !== "string") {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}

/** Raw session token of the current request (server use only). */
export async function readSessionToken() {
	const cookieStore = await cookies();
	return String(cookieStore.get(SESSION_COOKIE)?.value);
}

export async function createSessionForUser(userId: string) {
	const token = await signToken(userId);
	const cookieStore = await cookies();

	cookieStore.set(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: SESSION_TTL_SECONDS,
	});
}

/**
 * The workspace a user lands in after sign-in: the one they own, otherwise
 * the first workspace they were invited to (members own no workspace).
 */
export async function findLandingWorkspace(userId: string) {
	const [owned] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.ownerId, userId))
		.orderBy(asc(workspaces.createdAt))
		.limit(1);
	if (owned) return owned;

	const [member] = await db
		.select({ workspace: workspaces })
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(eq(workspaceMembers.userId, userId))
		.orderBy(asc(workspaceMembers.createdAt))
		.limit(1);
	return member?.workspace ?? null;
}

export async function getWorkspaceRedirectUrl(
	user: Pick<typeof users.$inferSelect, "id">,
) {
	const workspace = await findLandingWorkspace(user.id);

	if (!workspace) {
		return "/auth/login";
	}

	await setWorkspaceContextCookies(workspace.publicId, workspace.id, user.id);

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

export async function signInUserAndRedirect(
	user: Pick<typeof users.$inferSelect, "id">,
	locale?: string,
) {
	await createSessionForUser(user.id);
	const target = await getWorkspaceRedirectUrl(user);
	// The locale comes from the login form: only known locales, otherwise
	// "/{locale}" could become a protocol-relative open redirect.
	redirect(
		typeof locale === "string" && hasLocale(locale)
			? withLocale(locale, target)
			: target,
	);
}
