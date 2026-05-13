import { getServerEnv } from "@schema";
import Redis from "ioredis";

let redis: Redis | null = null;

function getRedisClient() {
	if (redis) return redis;

	const { REDIS_HOST, REDIS_PASSWORD, REDIS_PORT } = getServerEnv();
	redis = new Redis({
		host: REDIS_HOST || "redis",
		port: Number(REDIS_PORT || 6379),
		password: REDIS_PASSWORD,
		maxRetriesPerRequest: 1,
		lazyConnect: true,
		enableOfflineQueue: false,
	});

	redis.on("error", () => {
		// Cache is best-effort. Never break dashboard rendering because Redis is slow/down.
	});

	return redis;
}

export async function withServerCache<T>(
	key: string,
	ttlSeconds: number,
	loader: () => Promise<T>,
): Promise<T> {
	const client = getRedisClient();

	try {
		if (client.status === "wait") {
			await client.connect();
		}

		const cached = await client.get(key);
		if (cached) {
			return JSON.parse(cached) as T;
		}
	} catch {
		return loader();
	}

	const value = await loader();

	try {
		await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
	} catch {
		// Best-effort cache write.
	}

	return value;
}
