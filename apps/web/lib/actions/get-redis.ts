import { getServerEnv } from "@schema";
import { type JobsOptions, Queue, QueueEvents } from "bullmq";

export type QueueName =
	| "smtp-worker"
	| "gmail-worker"
	| "send-mail"
	| "search-ingest"
	| "migration-worker"
	| "dav-worker"
	| "common-worker"
	| "jmap-worker";

function baseConnection() {
	const { REDIS_PASSWORD, REDIS_HOST, REDIS_PORT } = getServerEnv();
	return {
		host: REDIS_HOST || "redis",
		port: Number(REDIS_PORT || 6379),
		password: REDIS_PASSWORD,
		// Never reconnect in the background: a broken client is dropped and
		// recreated on the next call (see dropQueue).
		retryStrategy: () => null,
	};
}

// Queues fail fast while Redis is down instead of hanging the action.
function queueConnection() {
	return {
		connection: {
			...baseConnection(),
			maxRetriesPerRequest: 1,
			enableOfflineQueue: false,
		},
	};
}

// QueueEvents use a blocking connection; BullMQ requires
// maxRetriesPerRequest: null for those.
function eventsConnection() {
	return { connection: baseConnection() };
}

type QueuePair = { queue: Queue; events?: QueueEvents };

// Queues and their event streams are shared per process. Creating them per
// call opened ~17 Redis connections for every mail action and never closed
// them.
const globalQueues = globalThis as unknown as {
	__kurrierWebQueues?: Map<QueueName, QueuePair>;
};
if (!globalQueues.__kurrierWebQueues) {
	globalQueues.__kurrierWebQueues = new Map();
}
const queues = globalQueues.__kurrierWebQueues;

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
			queue: new Queue(name, queueConnection()),
		};
		// Callers surface failures; the next call gets a fresh client.
		created.queue.on("error", () => dropQueue(name, created));
		// A clean socket close (e.g. Redis restart) emits no "error".
		created.queue.on("ioredis:close", () => dropQueue(name, created));
		queues.set(name, created);
		pair = created;
	}
	return pair;
}

/** Shared queue (not awaited until ready; `add` waits for the connection). */
export function getQueue(name: QueueName): Queue {
	return getPair(name).queue;
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

/** Shared, ready event stream of a queue. */
export async function getQueueEvents(name: QueueName): Promise<QueueEvents> {
	const pair = getPair(name);
	if (!pair.events) {
		const events = new QueueEvents(name, eventsConnection());
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

/**
 * Queue plus its event stream, for callers that wait for a job result.
 * The events are subscribed before the caller adds a job, so no completion
 * event is missed.
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
	ttl?: number,
): Promise<T> {
	const { queue, events } = await getQueueWithEvents(name);
	const job = await queue.add(jobName, data, opts);
	return (await job.waitUntilFinished(events, ttl)) as T;
}

/** Add several jobs in one Redis round trip and wait for all of them. */
export async function addBulkAndWait<T = unknown>(
	name: QueueName,
	jobs: { name: string; data: unknown; opts?: JobsOptions }[],
	ttl?: number,
): Promise<T[]> {
	if (!jobs.length) return [];
	const { queue, events } = await getQueueWithEvents(name);
	const added = await queue.addBulk(jobs);
	return (await Promise.all(
		added.map((job) => job.waitUntilFinished(events, ttl)),
	)) as T[];
}

/** Add several jobs in one Redis round trip. */
export async function addBulk(
	name: QueueName,
	jobs: { name: string; data: unknown; opts?: JobsOptions }[],
) {
	if (!jobs.length) return [];
	return getQueue(name).addBulk(jobs);
}

export const RETRY_JOB_OPTS = {
	attempts: 3,
	backoff: { type: "exponential", delay: 1500 },
} satisfies JobsOptions;

/** Default options for fire-and-forget jobs (retried, removed when done). */
export const DEFAULT_JOB_OPTS = {
	...RETRY_JOB_OPTS,
	removeOnComplete: true,
	removeOnFail: false,
} satisfies JobsOptions;

/** Re-index threads in Typesense (deduplicated per thread by jobId). */
export function enqueueSearchRefresh(threadIds: string[]) {
	const ids = Array.from(new Set(threadIds.filter(Boolean).map(String)));
	return addBulk(
		"search-ingest",
		ids.map((threadId) => ({
			name: "refresh-thread",
			data: { threadId },
			opts: { ...DEFAULT_JOB_OPTS, jobId: `refresh-${threadId}` },
		})),
	);
}

type LegacyRedis = {
	smtpQueue: Queue;
	smtpEvents: QueueEvents;
	gmailQueue: Queue;
	gmailEvents: QueueEvents;
	sendMailQueue: Queue;
	sendMailEvents: QueueEvents;
	searchIngestQueue: Queue;
	searchIngestEvents: QueueEvents;
	migrationWorkerQueue: Queue;
	migrationWorkerEvents: QueueEvents;
	davQueue: Queue;
	davEvents: QueueEvents;
	commonWorkerQueue: Queue;
	commonWorkerEvents: QueueEvents;
	jmapQueue: Queue;
	jmapEvents: QueueEvents;
};

const LEGACY_KEYS: Record<string, QueueName> = {
	smtp: "smtp-worker",
	gmail: "gmail-worker",
	sendMail: "send-mail",
	searchIngest: "search-ingest",
	migrationWorker: "migration-worker",
	dav: "dav-worker",
	commonWorker: "common-worker",
	jmap: "jmap-worker",
};

/**
 * @deprecated Use getQueue / getQueueWithEvents / addJobAndWait.
 * Compatibility wrapper: returns the shared per-process instances, created
 * lazily on property access. Only the `*Events` streams that are actually
 * read are connected (and awaited ready here would require knowing them in
 * advance, so prefer getQueueWithEvents when waiting for a job).
 */
export const getRedis = async (): Promise<LegacyRedis> => {
	const result = {} as LegacyRedis;
	for (const [prefix, name] of Object.entries(LEGACY_KEYS)) {
		Object.defineProperty(result, `${prefix}Queue`, {
			enumerable: true,
			get: () => getQueue(name),
		});
		Object.defineProperty(result, `${prefix}Events`, {
			enumerable: true,
			get: () => {
				// Create (and start connecting) the shared stream.
				void getQueueEvents(name).catch(() => {});
				return getPair(name).events as QueueEvents;
			},
		});
	}
	return result;
};
