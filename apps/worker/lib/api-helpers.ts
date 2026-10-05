import crypto from "node:crypto";
import net from "node:net";
import {
	apiKeys,
	db,
	getSecretAdmin,
	identities,
	secretsMeta,
	users,
	workspaceMembers,
	workspaces,
} from "@db";
import { httpOutboundPolicy, isBlockedIp } from "@providers/net-guard";
import type { apiScopeList } from "@schema";
import { and, eq } from "drizzle-orm";
import { createError, type H3Event, readRawBody } from "h3";

export type ApiScope = (typeof apiScopeList)[number];

/**
 * Scope sets used by the /api/kurrier routes. A key passes when it holds at
 * least one of the listed scopes (any-of).
 *
 * Backward compatible: scopes are only enforced when the key carries a
 * non-empty scopes list. Management routes (identities, webhooks, me,
 * smtp-accounts, inbound) accept either email scope so that keys created
 * with the old default (`emails:send` only) keep working. Only the mailbox
 * read API (new) requires `emails:receive`, and sending `emails:send`.
 */
export const API_SCOPES = {
	read: ["emails:receive"],
	send: ["emails:send"],
	manage: ["emails:send", "emails:receive"],
} as const satisfies Record<string, readonly ApiScope[]>;

export function apiSuccess(data: any = null) {
	return {
		success: true,
		data,
	};
}

export function apiError(
	statusCode: number,
	code: string,
	message: string,
	issues?: any,
) {
	throw createError({
		statusCode,
		statusMessage: message,
		data: {
			success: false,
			error: {
				code,
				message,
				issues,
			},
		},
	});
}

export async function validateJSONBody(event: H3Event) {
	const raw = (await readRawBody(event)) || "";
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch (e) {
		throw createError({
			statusCode: 400,
			statusMessage: "Invalid JSON in request body",
		});
	}

	return { raw, json };
}

function safeEqual(a: string, b: string) {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);

	if (ab.length !== bb.length) return false;

	return crypto.timingSafeEqual(ab, bb);
}

async function isWorkspaceMember(workspaceId: string, userId: string) {
	const [member] = await db
		.select({ id: workspaceMembers.id })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.userId, userId),
			),
		)
		.limit(1);
	if (member) return true;

	const [owned] = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)))
		.limit(1);
	return Boolean(owned);
}

/**
 * Validates a user supplied webhook URL at create/update time: absolute
 * http(s) URL whose host is not a literal internal/metadata address.
 * Hostnames are resolved and checked again at delivery time.
 */
export function assertValidWebhookUrl(value: unknown) {
	let url: URL | null = null;
	try {
		url = new URL(String(value ?? ""));
	} catch {
		url = null;
	}
	const host = url?.hostname.replace(/^\[|\]$/g, "") ?? "";
	if (
		!url ||
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		!host ||
		(net.isIP(host) !== 0 && isBlockedIp(host, httpOutboundPolicy()))
	) {
		throw createError({
			statusCode: 400,
			statusMessage:
				"Webhook url must be a public http(s) URL (internal addresses are not allowed)",
			data: {
				success: false,
				error: {
					code: "INVALID_WEBHOOK_URL",
					message: "Webhook url must be a public http(s) URL",
				},
			},
		});
	}
}

/**
 * Throws 403 when the key has a non-empty scopes list that contains none of
 * `requiredScopes`. Keys without scopes and calls without required scopes
 * are not restricted.
 */
export function assertApiKeyScopes(
	keyScopes: readonly string[] | null | undefined,
	requiredScopes: readonly ApiScope[] = [],
) {
	if (!requiredScopes.length || !keyScopes?.length) return;
	if (requiredScopes.some((scope) => keyScopes.includes(scope))) return;

	throw createError({
		statusCode: 403,
		statusMessage: `API key is missing the required scope (${requiredScopes.join(" or ")})`,
		data: {
			success: false,
			error: {
				code: "INSUFFICIENT_SCOPE",
				message: "API key does not have the required scope",
				requiredScopes,
			},
		},
	});
}

export async function validateApiKey(
	event: H3Event,
	requiredScopes: readonly ApiScope[] = [],
) {
	const auth = event.node.req.headers.authorization;

	if (!auth || !auth.startsWith("Bearer ")) {
		throw createError({
			statusCode: 401,
			statusMessage: "Missing or invalid Authorization header",
		});
	}

	const token = auth.replace("Bearer ", "").trim();

	const parts = token.split(".");
	if (parts.length < 2) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key format",
		});
	}

	const prefix = parts[0];
	const rest = parts.slice(1).join(".");
	const last4 = rest.slice(-4);

	if (!prefix || last4.length !== 4) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key format",
		});
	}

	const [key] = await db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.keyLast4, last4)))
		.limit(1);

	if (!key) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key",
		});
	}

	if (key.revokedAt) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key has been revoked",
		});
	}

	if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key has expired",
		});
	}

	const [secretMeta] = await db
		.select()
		.from(secretsMeta)
		.where(eq(secretsMeta.id, key.secretId))
		.limit(1);

	if (!secretMeta) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key secret not found",
		});
	}

	const actualSecret = await getSecretAdmin(secretMeta.id);

	if (!actualSecret?.vault?.decrypted_secret) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key secret not found",
		});
	}

	const { rawKey } = JSON.parse(actualSecret.vault.decrypted_secret);

	if (!rawKey || !safeEqual(rawKey, token)) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key",
		});
	}

	assertApiKeyScopes(key.scopes, requiredScopes);

	// Keys are bound to a workspace: once the owner leaves (or is removed
	// from) it, the key must stop working instead of keeping access to the
	// workspace's shared identities.
	if (!(await isWorkspaceMember(key.workspaceId, key.ownerId))) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key owner is not a member of the key's workspace",
		});
	}

	return {
		apiKey: key,
		secret: rawKey,
		ownerId: key.ownerId,
	};
}

/**
 * Instance-level admin authentication for the management API.
 *
 * When the API_ADMIN_KEY environment variable is set (32+ chars), requests
 * bearing it may act on behalf of any user — e.g. to provision accounts
 * before their first login. Opt-in: without the env var this always
 * returns false and only regular per-user API keys work.
 */
export function isAdminApiRequest(event: H3Event): boolean {
	const adminKey = process.env.API_ADMIN_KEY;
	if (!adminKey || adminKey.length < 32) return false;

	const auth = event.node.req.headers.authorization;
	if (!auth || !auth.startsWith("Bearer ")) return false;

	const token = auth.replace("Bearer ", "").trim();
	return safeEqual(token, adminKey);
}

export function requireAdminApiKey(event: H3Event) {
	if (!isAdminApiRequest(event)) {
		throw createError({
			statusCode: 401,
			statusMessage: "This endpoint requires the admin API key",
		});
	}
}

export type ApiActor = {
	ownerId: string;
	workspaceId: string;
	isAdmin: boolean;
	/** Scopes of the API key; null for the admin key (unrestricted). */
	scopes: readonly string[] | null;
};

/**
 * Resolves who a management API request acts as.
 *
 * - Regular API key: the key's owner and workspace (userEmail is rejected).
 * - Admin API key: the user designated by userEmail and the workspace they
 *   own, so one infrastructure-held key can manage every account.
 */
export async function resolveApiActor(
	event: H3Event,
	userEmail?: string | null,
	requiredScopes: readonly ApiScope[] = [],
): Promise<ApiActor> {
	if (isAdminApiRequest(event)) {
		if (!userEmail) {
			throw createError({
				statusCode: 400,
				statusMessage:
					"userEmail is required when authenticating with the admin API key",
			});
		}

		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.email, userEmail))
			.limit(1);

		if (!user) {
			throw createError({
				statusCode: 404,
				statusMessage: "User not found",
			});
		}

		const [workspace] = await db
			.select()
			.from(workspaces)
			.where(eq(workspaces.ownerId, user.id))
			.limit(1);

		if (!workspace) {
			throw createError({
				statusCode: 404,
				statusMessage: "User has no workspace",
			});
		}

		return {
			ownerId: user.id,
			workspaceId: workspace.id,
			isAdmin: true,
			scopes: null,
		};
	}

	if (userEmail) {
		throw createError({
			statusCode: 403,
			statusMessage: "userEmail requires the admin API key",
		});
	}

	const { apiKey, ownerId } = await validateApiKey(event, requiredScopes);
	return {
		ownerId,
		workspaceId: apiKey.workspaceId,
		isAdmin: false,
		scopes: apiKey.scopes,
	};
}

export async function validateIdentityOwnership(opts: {
	identityId: string;
	ownerId: string;
	/** When set, the identity must also belong to this workspace. */
	workspaceId?: string;
}) {
	if (!UUID_RE.test(opts.identityId)) {
		throw createError({
			statusCode: 403,
			statusMessage: "Identity not found or access denied",
		});
	}

	const [identity] = await db
		.select()
		.from(identities)
		.where(
			and(
				eq(identities.id, opts.identityId),
				eq(identities.ownerId, opts.ownerId),
				opts.workspaceId
					? eq(identities.workspaceId, opts.workspaceId)
					: undefined,
			),
		)
		.limit(1);

	if (!identity) {
		throw createError({
			statusCode: 403,
			statusMessage: "Identity not found or access denied",
		});
	}
	return identity;
}

export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
