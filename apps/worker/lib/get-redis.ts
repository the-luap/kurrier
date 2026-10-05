import IORedis from "ioredis";
import {
	type ConnectionOptions,
	Queue,
	QueueEvents,
	type WorkerOptions,
} from "bullmq";
import { getServerEnv } from "@schema";

const serverConfig = getServerEnv();

const redisOptions = {
	host: serverConfig.REDIS_HOST || "redis",
	port: Number(serverConfig.REDIS_PORT || 6379),
	password: serverConfig.REDIS_PASSWORD,
};

// Workers require maxRetriesPerRequest: null (they duplicate this
// connection for their blocking client). One shared command connection for
// every Worker in this process.
const redis = new IORedis({
	...redisOptions,
	maxRetriesPerRequest: null,
});
redis.on("error", (error) => {
	console.error("[redis] worker connection error:", error.message);
});

// One shared command connection for every Queue. It keeps the default
// retry limit so queue.add() fails instead of hanging while Redis is down.
const queueRedis = new IORedis(redisOptions);
queueRedis.on("error", (error) => {
	console.error("[redis] queue connection error:", error.message);
});

/** Plain connection options (each consumer opens its own connection). */
export const redisConnection = {
	connection: redisOptions,
};

// bullmq resolves its own ioredis copy (same major version, duck-typed at
// runtime), so the shared instances are passed as ConnectionOptions.
const workerConnection = redis as unknown as ConnectionOptions;
const queueOptions = {
	connection: queueRedis as unknown as ConnectionOptions,
};
// QueueEvents need a dedicated blocking connection, so they get plain options.
const eventsOptions = { connection: redisOptions };

/**
 * Default retention for finished jobs. Applied by every worker to jobs that
 * were enqueued without their own removeOnComplete/removeOnFail, which
 * otherwise stay in Redis forever (send jobs even carry the full mail payload).
 */
export const DEFAULT_WORKER_OPTIONS = {
	removeOnComplete: { age: 60 * 60, count: 1000 },
	removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
} satisfies Partial<WorkerOptions>;

/** Worker options: shared worker connection plus default job retention. */
export function workerOptions(
	opts: Partial<Omit<WorkerOptions, "connection">> = {},
): WorkerOptions {
	return {
		connection: workerConnection,
		...DEFAULT_WORKER_OPTIONS,
		...opts,
	};
}

const smtpQueue = new Queue("smtp-worker", queueOptions);
const smtpEvents = new QueueEvents("smtp-worker", eventsOptions);

const gmailQueue = new Queue("gmail-worker", queueOptions);
const gmailEvents = new QueueEvents("gmail-worker", eventsOptions);

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

const jmapQueue = new Queue("jmap-worker", queueOptions);
const jmapEvents = new QueueEvents("jmap-worker", eventsOptions);

for (const queue of [
	smtpQueue,
	gmailQueue,
	sendMailQueue,
	searchIngestQueue,
	commonWorkerQueue,
	migrationWorkerQueue,
	davWorkerQueue,
	jmapQueue,
]) {
	queue.on("error", (error) => {
		console.error(`[redis] queue ${queue.name} error:`, error.message);
	});
}

export async function getRedis() {
	await Promise.all([
		smtpEvents.waitUntilReady(),
		sendMailEvents.waitUntilReady(),
		searchIngestEvents.waitUntilReady(),
		commonWorkerEvents.waitUntilReady(),
		migrationWorkerEvents.waitUntilReady(),
		davWorkerEvents.waitUntilReady(),
		gmailEvents.waitUntilReady(),
		jmapEvents.waitUntilReady(),
		jmapQueue.waitUntilReady(),
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
		gmailQueue,
		gmailEvents,
		jmapQueue,
		jmapEvents,
	};
}
