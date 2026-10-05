import { getServerEnv } from "@schema";
import Redis from "ioredis";

let redis: Redis | null = null;
let connecting: Promise<void> | null = null;

const cacheEnabled = () => process.env.ENABLE_SERVER_CACHE === "true";

function getRedisClient() {
	if (redis) return redis;

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
		// Cache is best-effort. Never break dashboard rendering because Redis is slow/down.
	});
	// retryStrategy is null, so a closed connection never comes back: forget it
	// and let the next call create a fresh client.
	client.on("end", () => {
		if (redis === client) {
			redis = null;
			connecting = null;
		}
	});

	redis = client;
	return client;
}

// All concurrent callers share one connect attempt instead of each one
// failing on a "connecting" client and tearing it down.
async function getConnectedClient(): Promise<Redis> {
	const client = getRedisClient();
	if (client.status === "ready") return client;
	if (client.status === "wait") {
		connecting = client.connect().catch((error) => {
			client.disconnect();
			throw error;
		});
	}
	if (connecting) await connecting;
	if ((client.status as string) !== "ready") {
		throw new Error("Server cache unavailable");
	}
	return client;
}

const generationKey = (userId: string) => `cache-gen:${userId}`;

/**
 * Cache a per-user value. Entries are versioned with a per-user generation
 * counter so invalidateServerCache() can drop all of them with one INCR.
 */
export async function withServerCache<T>(
	userId: string,
	key: string,
	ttlSeconds: number,
	loader: () => Promise<T>,
): Promise<T> {
	if (!cacheEnabled()) {
		return loader();
	}

	let client: Redis;
	let versionedKey: string;
	try {
		client = await getConnectedClient();
		const generation = (await client.get(generationKey(userId))) ?? "0";
		versionedKey = `${key}#${generation}`;
		const cached = await client.get(versionedKey);
		if (cached) {
			return JSON.parse(cached) as T;
		}
	} catch {
		return loader();
	}

	const value = await loader();

	try {
		await client.set(versionedKey, JSON.stringify(value), "EX", ttlSeconds);
	} catch {
		// Best-effort cache write.
	}

	return value;
}

/** Drop every cached entry of a user, e.g. after a mutation. */
export async function invalidateServerCache(userId: string | null | undefined) {
	if (!cacheEnabled() || !userId) return;

	try {
		const client = await getConnectedClient();
		await client
			.multi()
			.incr(generationKey(userId))
			.expire(generationKey(userId), 60 * 60 * 24)
			.exec();
	} catch {
		// Best-effort: entries expire on their own after a few seconds.
	}
}
