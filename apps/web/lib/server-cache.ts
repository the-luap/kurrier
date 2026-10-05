import { getServerEnv } from "@schema";
import Redis from "ioredis";
import { isSignedIn } from "@/lib/actions/auth";
import { getWorkspaceId } from "@/lib/actions/clients";

/**
 * Best-effort Redis cache for expensive, frequently rendered loaders (mail
 * sidebar lists and counts). Off unless ENABLE_SERVER_CACHE=true.
 *
 * Entries are scoped to workspace AND user (RLS results differ per member),
 * and versioned with a per-workspace generation counter: one INCR after a
 * mutation drops the entries of every member of that workspace, since
 * mailboxes can be shared between members.
 *
 * Redis being slow or down never breaks rendering: every failure falls back
 * to the loader, with short connect/command timeouts.
 */

const cacheEnabled = () => process.env.ENABLE_SERVER_CACHE === "true";

const globalCache = globalThis as unknown as {
	__kurrierServerCache?: {
		redis: Redis | null;
		connecting: Promise<void> | null;
	};
};
if (!globalCache.__kurrierServerCache) {
	globalCache.__kurrierServerCache = { redis: null, connecting: null };
}
const state = globalCache.__kurrierServerCache;

function getRedisClient() {
	if (state.redis) return state.redis;

	const { REDIS_HOST, REDIS_PASSWORD, REDIS_PORT } = getServerEnv();
	const client = new Redis({
		host: REDIS_HOST || "redis",
		port: Number(REDIS_PORT || 6379),
		password: REDIS_PASSWORD,
		maxRetriesPerRequest: 1,
		lazyConnect: true,
		enableOfflineQueue: false,
		retryStrategy: () => null,
		connectTimeout: 500,
		commandTimeout: 500,
	});

	client.on("error", () => {
		// Best-effort: callers fall back to the loader.
	});
	// retryStrategy is null, so a closed connection never comes back: forget
	// it and let the next call create a fresh client.
	client.on("end", () => {
		if (state.redis === client) {
			state.redis = null;
			state.connecting = null;
		}
	});

	state.redis = client;
	return client;
}

// Concurrent callers share one connect attempt instead of each one failing
// on a "connecting" client and tearing it down.
async function getConnectedClient(): Promise<Redis> {
	const client = getRedisClient();
	if (client.status === "ready") return client;
	if (client.status === "wait") {
		state.connecting = client.connect().catch((error) => {
			client.disconnect();
			throw error;
		});
	}
	if (state.connecting) await state.connecting;
	if ((client.status as string) !== "ready") {
		throw new Error("Server cache unavailable");
	}
	return client;
}

const generationKey = (workspaceId: string) => `kc:gen:${workspaceId}`;

// JSON with Date and Map preserved, so cached values have the same shape as
// fresh ones (rows carry Date columns; some loaders return Maps).
function serialize(value: unknown) {
	return JSON.stringify(value, function (this: Record<string, unknown>, key, val) {
		const raw = this[key];
		if (raw instanceof Date) return { __kcDate: raw.toISOString() };
		if (raw instanceof Map) return { __kcMap: Array.from(raw.entries()) };
		return val;
	});
}

function deserialize<T>(text: string): T {
	return JSON.parse(text, (_key, val) => {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			if (typeof val.__kcDate === "string" && Object.keys(val).length === 1) {
				return new Date(val.__kcDate);
			}
			if (Array.isArray(val.__kcMap) && Object.keys(val).length === 1) {
				return new Map(val.__kcMap);
			}
		}
		return val;
	}) as T;
}

async function currentScope(): Promise<{
	workspaceId: string;
	userId: string;
} | null> {
	try {
		const [user, workspaceId] = await Promise.all([
			isSignedIn(),
			getWorkspaceId(),
		]);
		if (!user?.id || !workspaceId) return null;
		return { workspaceId, userId: String(user.id) };
	} catch {
		return null;
	}
}

/**
 * Cache `loader()` for the current workspace + user under `key`.
 * Without a signed-in user / workspace, or with the cache off, it just runs
 * the loader.
 */
export async function withServerCache<T>(
	key: string,
	ttlSeconds: number,
	loader: () => Promise<T>,
): Promise<T> {
	if (!cacheEnabled()) return loader();

	const scope = await currentScope();
	if (!scope) return loader();

	let client: Redis;
	let versionedKey: string;
	try {
		client = await getConnectedClient();
		const generation =
			(await client.get(generationKey(scope.workspaceId))) ?? "0";
		versionedKey = `kc:${scope.workspaceId}:${scope.userId}:${key}#${generation}`;
		const cached = await client.get(versionedKey);
		if (cached) return deserialize<T>(cached);
	} catch {
		return loader();
	}

	const value = await loader();

	try {
		await client.set(versionedKey, serialize(value), "EX", ttlSeconds);
	} catch {
		// Best-effort cache write.
	}

	return value;
}

/**
 * Drop every cached entry of the current workspace (all members), e.g. after
 * a mail mutation. Pass `workspaceId` when it is already known.
 */
export async function invalidateServerCache(workspaceId?: string | null) {
	if (!cacheEnabled()) return;

	try {
		const id = workspaceId || (await currentScope())?.workspaceId;
		if (!id) return;
		const client = await getConnectedClient();
		await client
			.multi()
			.incr(generationKey(id))
			.expire(generationKey(id), 60 * 60 * 24)
			.exec();
	} catch {
		// Best-effort: entries expire on their own after a few seconds.
	}
}
