import { getServerEnv } from "@schema";
import { Queue, QueueEvents } from "bullmq";

type RedisConnection = {
	connection: {
		host: string;
		port: number;
		password: string;
		maxRetriesPerRequest: number;
		enableOfflineQueue: boolean;
		retryStrategy: () => null;
	};
};

function getRedisConnection(): RedisConnection {
	const { REDIS_PASSWORD, REDIS_HOST, REDIS_PORT } = getServerEnv();

	return {
		connection: {
			host: REDIS_HOST || "redis",
			port: Number(REDIS_PORT || 6379),
			password: REDIS_PASSWORD,
			maxRetriesPerRequest: 1,
			enableOfflineQueue: false,
			retryStrategy: () => null,
		},
	};
}

function silenceRedisErrors<
	T extends { on: (event: "error", cb: () => void) => T },
>(client: T): T {
	return client.on("error", () => {
		// Redis-backed queues are best-effort at render time; callers surface failures.
	});
}

export const getRedis = async () => {
	const redisConnection = getRedisConnection();
	const smtpQueue = silenceRedisErrors(
		new Queue("smtp-worker", redisConnection),
	);
	const smtpEvents = silenceRedisErrors(
		new QueueEvents("smtp-worker", redisConnection),
	);

	const sendMailQueue = silenceRedisErrors(
		new Queue("send-mail", redisConnection),
	);
	const sendMailEvents = silenceRedisErrors(
		new QueueEvents("send-mail", redisConnection),
	);

	const searchIngestQueue = silenceRedisErrors(
		new Queue("search-ingest", redisConnection),
	);
	const searchIngestEvents = silenceRedisErrors(
		new QueueEvents("search-ingest", redisConnection),
	);

	const migrationWorkerQueue = silenceRedisErrors(
		new Queue("migration-worker", redisConnection),
	);
	const migrationWorkerEvents = silenceRedisErrors(
		new QueueEvents("migration-worker", redisConnection),
	);

	const davQueue = silenceRedisErrors(new Queue("dav-worker", redisConnection));
	const davEvents = silenceRedisErrors(
		new QueueEvents("dav-worker", redisConnection),
	);

	await smtpEvents.waitUntilReady();
	await sendMailEvents.waitUntilReady();
	await searchIngestEvents.waitUntilReady();
	await davEvents.waitUntilReady();
	await migrationWorkerEvents.waitUntilReady();

	return {
		smtpQueue,
		smtpEvents,
		sendMailQueue,
		sendMailEvents,
		searchIngestQueue,
		searchIngestEvents,
		davQueue,
		davEvents,
		migrationWorkerQueue,
		migrationWorkerEvents,
	};
};
