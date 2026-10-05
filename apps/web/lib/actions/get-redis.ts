import { getServerEnv } from "@schema";
import { type JobsOptions, Queue, QueueEvents } from "bullmq";

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

export type QueueName =
	| "smtp-worker"
	| "send-mail"
	| "search-ingest"
	| "migration-worker"
	| "dav-worker"
	| "common-worker";

type QueuePair = { queue: Queue; events?: QueueEvents };

// Queues and their event streams are shared per process. Creating them per
// call leaked ~10 Redis connections for every mail action. The connections
// don't reconnect (retryStrategy: null), so a client that errors is dropped
// and recreated on the next call.
const globalQueues = globalThis as unknown as {
	__kurrierQueues?: Map<QueueName, QueuePair>;
};
if (!globalQueues.__kurrierQueues) globalQueues.__kurrierQueues = new Map();
const queues = globalQueues.__kurrierQueues;

function dropQueue(name: QueueName, pair: QueuePair) {
	if (queues.get(name) !== pair) return;
	queues.delete(name);
	pair.queue.close().catch(() => {});
	pair.events?.close().catch(() => {});
}

function getPair(name: QueueName): QueuePair {
	let pair = queues.get(name);
	if (!pair) {
		const created: QueuePair = {
			queue: new Queue(name, getRedisConnection()),
		};
		// Redis-backed queues are best-effort at render time; callers surface failures.
		created.queue.on("error", () => dropQueue(name, created));
		// A clean socket close (e.g. Redis restart) emits no "error".
		created.queue.on("ioredis:close", () => dropQueue(name, created));
		queues.set(name, created);
		pair = created;
	}
	return pair;
}

export function getQueue(name: QueueName): Queue {
	return getPair(name).queue;
}

export async function getQueueEvents(name: QueueName): Promise<QueueEvents> {
	const pair = getPair(name);
	if (!pair.events) {
		const events = new QueueEvents(name, getRedisConnection());
		events.on("error", () => dropQueue(name, pair));
		events.on("ioredis:close", () => dropQueue(name, pair));
		pair.events = events;
	}
	try {
		await pair.events.waitUntilReady();
	} catch (error) {
		dropQueue(name, pair);
		throw error;
	}
	return pair.events;
}

/** Queue that has finished connecting (fails fast while Redis is down). */
export async function getReadyQueue(name: QueueName): Promise<Queue> {
	const pair = getPair(name);
	try {
		await pair.queue.waitUntilReady();
	} catch (error) {
		dropQueue(name, pair);
		throw error;
	}
	return pair.queue;
}

export const getSmtpQueue = async () => ({
	smtpQueue: await getReadyQueue("smtp-worker"),
});

/**
 * Queue plus its event stream, for callers that wait for a job result.
 * Only connects the one stream that is needed. The events are subscribed before the caller adds a job, so
 * no completion event is missed.
 */
export async function getQueueWithEvents(name: QueueName) {
	const events = await getQueueEvents(name);
	return { queue: getQueue(name), events };
}

/** Add a job and wait for its return value. */
export async function addJobAndWait<T = unknown>(
	name: QueueName,
	jobName: string,
	data: unknown,
	opts?: JobsOptions,
): Promise<T> {
	const { queue, events } = await getQueueWithEvents(name);
	const job = await queue.add(jobName, data, opts);
	return (await job.waitUntilFinished(events)) as T;
}

export const RETRY_JOB_OPTS = {
	attempts: 3,
	backoff: { type: "exponential", delay: 1500 },
} satisfies JobsOptions;
