import IORedis from "ioredis";
import { Queue, QueueEvents, type WorkerOptions } from "bullmq";
import { getServerEnv } from "@schema";

const serverConfig = getServerEnv();

const redisOptions = {
	host: serverConfig.REDIS_HOST || "redis",
	port: Number(serverConfig.REDIS_PORT || 6379),
	password: serverConfig.REDIS_PASSWORD,
};

// Workers require maxRetriesPerRequest: null (they duplicate this
// connection for their blocking client).
const redis = new IORedis({
	...redisOptions,
	maxRetriesPerRequest: null,
});

// One shared command connection for every Queue. It keeps the default
// retry limit so queue.add() fails instead of hanging while Redis is down.
const queueRedis = new IORedis(redisOptions);
queueRedis.on("error", (error) => {
	console.error("[redis] queue connection error:", error.message);
});

const queueOptions = { connection: queueRedis };
// QueueEvents need a dedicated blocking connection, so they get plain options.
const eventsOptions = { connection: redisOptions };

/**
 * Default retention for finished jobs. Applied by every worker to jobs that
 * were enqueued without their own removeOnComplete/removeOnFail, which
 * otherwise stay in Redis forever (webhook jobs even carry the raw email).
 */
export const DEFAULT_WORKER_OPTIONS = {
	removeOnComplete: { age: 60 * 60, count: 1000 },
	removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
} satisfies Partial<WorkerOptions>;

export function workerOptions(
	opts: Partial<Omit<WorkerOptions, "connection">> = {},
): WorkerOptions {
	return { connection: redis, ...DEFAULT_WORKER_OPTIONS, ...opts };
}

const smtpQueue = new Queue("smtp-worker", queueOptions);
const smtpEvents = new QueueEvents("smtp-worker", eventsOptions);

const sendMailQueue = new Queue("send-mail", queueOptions);
const sendMailEvents = new QueueEvents("send-mail", eventsOptions);

const searchIngestQueue = new Queue("search-ingest", queueOptions);
const searchIngestEvents = new QueueEvents("search-ingest", eventsOptions);

const commonWorkerQueue = new Queue("common-worker", queueOptions);
const commonWorkerEvents = new QueueEvents("common-worker", eventsOptions);

const migrationWorkerQueue = new Queue("migration-worker", queueOptions);
const migrationWorkerEvents = new QueueEvents(
	"migration-worker",
	eventsOptions,
);

const davWorkerQueue = new Queue("dav-worker", queueOptions);
const davWorkerEvents = new QueueEvents("dav-worker", eventsOptions);

export async function getRedis() {
	await Promise.all([
		smtpEvents.waitUntilReady(),
		sendMailEvents.waitUntilReady(),
		searchIngestEvents.waitUntilReady(),
		commonWorkerEvents.waitUntilReady(),
		migrationWorkerEvents.waitUntilReady(),
		davWorkerEvents.waitUntilReady(),
	]);
	return {
		connection: redis,
		smtpQueue,
		smtpEvents,
		sendMailQueue,
		sendMailEvents,
		searchIngestQueue,
		searchIngestEvents,
		commonWorkerQueue,
		commonWorkerEvents,
		migrationWorkerQueue,
		migrationWorkerEvents,
		davWorkerQueue,
		davWorkerEvents,
	};
}

/**
 * Re-index a thread in Typesense. The fixed jobId collapses duplicate
 * refreshes that are still pending.
 */
export async function enqueueThreadRefresh(threadId: string) {
	const { searchIngestQueue } = await getRedis();
	return searchIngestQueue.add(
		"refresh-thread",
		{ threadId },
		{
			jobId: `refresh-${threadId}`,
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
		},
	);
}
