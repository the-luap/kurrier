import "server-only";

import type { JobsOptions } from "bullmq";
import {
	addBulk,
	addJobAndWait,
	DEFAULT_JOB_OPTS,
	getQueue,
	getReadyQueue,
	type QueueName,
} from "@/lib/actions/get-redis";

/*
 * Worker job helpers for the mail actions. This module is NOT a server
 * action module: its functions do no ownership checks and must only be
 * called after the caller verified the ids through RLS.
 */

/** Normalize the "one id or many" argument of the mail actions. */
export const toIdList = (ids: string | string[] | null | undefined) =>
	Array.from(
		new Set(
			(Array.isArray(ids) ? ids : [ids])
				.filter(Boolean)
				.map(String)
				.filter((id) => id !== "undefined" && id !== "null"),
		),
	);

export const isGmailMetaData = (metaData: unknown) =>
	Boolean((metaData as any)?.gmail?.googleAccountId);

/** One smtp-worker job per thread, sent in one Redis round trip. */
export function enqueueThreadSmtpJobs(
	jobName: string,
	threadIds: string[],
	data: (threadId: string) => Record<string, unknown>,
	opts: (threadId: string) => JobsOptions = () => DEFAULT_JOB_OPTS,
) {
	return addBulk(
		"smtp-worker",
		threadIds.map((threadId) => ({
			name: jobName,
			data: { threadId, ...data(threadId) },
			opts: opts(threadId),
		})),
	);
}

export type DeltaFetchQueue = "smtp" | "gmail";

export type DeltaFetchResult = {
	success: boolean;
	jobId: string | null;
	queue: DeltaFetchQueue | null;
	state: string;
	error: string | null;
};

export const DELTA_FETCH_JOB_PREFIX = {
	smtp: "delta-fetch-",
	gmail: "gmail-delta-sync-",
} as const satisfies Record<DeltaFetchQueue, string>;

export const deltaFetchQueueName = (queue: DeltaFetchQueue): QueueName =>
	queue === "gmail" ? "gmail-worker" : "smtp-worker";

/** Which queue a delta-fetch job id belongs to (null for foreign ids). */
export function deltaFetchQueueOfJob(jobId: string): DeltaFetchQueue | null {
	if (jobId.startsWith(DELTA_FETCH_JOB_PREFIX.gmail)) return "gmail";
	if (jobId.startsWith(DELTA_FETCH_JOB_PREFIX.smtp)) return "smtp";
	return null;
}

type SyncableIdentity = {
	id: string;
	workspaceId: string;
	smtpAccountId: string | null;
	metaData: unknown;
};

/** Queue for an identity's delta sync, or null if it has no remote mailbox. */
export function deltaFetchQueueFor(
	identity: SyncableIdentity,
): DeltaFetchQueue | null {
	if (isGmailMetaData(identity.metaData)) return "gmail";
	if (identity.smtpAccountId) return "smtp";
	return null;
}

const deltaFetchJob = (
	identity: SyncableIdentity,
	queue: DeltaFetchQueue,
	suffix: string,
) => ({
	name: queue === "gmail" ? "gmail:delta-sync" : "delta-fetch",
	data:
		queue === "gmail"
			? { identityId: identity.id, workspaceId: identity.workspaceId }
			: { identityId: identity.id },
	opts: {
		// Unique id so the status of this very run can be polled; kept for a
		// while after it finished.
		jobId: `${DELTA_FETCH_JOB_PREFIX[queue]}${identity.id}-${suffix}`,
		removeOnComplete: { age: 300 },
		removeOnFail: { age: 900 },
	} satisfies JobsOptions,
});

/** Enqueue a delta sync without waiting for it (poll with the job id). */
export async function queueDeltaFetch(
	identity: SyncableIdentity,
): Promise<DeltaFetchResult> {
	const queue = deltaFetchQueueFor(identity);
	if (!queue) {
		return {
			success: true,
			jobId: null,
			queue: null,
			state: "completed",
			error: null,
		};
	}
	const job = deltaFetchJob(identity, queue, String(Date.now()));
	const ready = await getReadyQueue(deltaFetchQueueName(queue));
	const added = await ready.add(job.name, job.data, job.opts);
	return {
		success: true,
		jobId: String(added.id),
		queue,
		state: await added.getState(),
		error: null,
	};
}

/** Enqueue delta syncs for many identities (one bulk add per queue). */
export async function queueDeltaFetchMany(identities: SyncableIdentity[]) {
	const suffix = String(Date.now());
	const byQueue = new Map<
		DeltaFetchQueue,
		ReturnType<typeof deltaFetchJob>[]
	>();
	for (const identity of identities) {
		const queue = deltaFetchQueueFor(identity);
		if (!queue) continue;
		const list = byQueue.get(queue) ?? [];
		list.push(deltaFetchJob(identity, queue, suffix));
		byQueue.set(queue, list);
	}

	const jobIds: string[] = [];
	let failed = 0;
	await Promise.all(
		Array.from(byQueue.entries()).map(async ([queue, jobs]) => {
			try {
				const added = await addBulk(deltaFetchQueueName(queue), jobs);
				jobIds.push(...added.map((job) => String(job.id)));
			} catch (error) {
				console.error(`Failed to enqueue ${queue} delta-fetch jobs`, error);
				failed += jobs.length;
			}
		}),
	);
	return { jobIds, failed };
}

/** IMAP: discover the folders (waits), then backfill and start IDLE. */
export async function queueImapBackfill(
	identityId: string,
	workspaceId: string,
) {
	await addJobAndWait(
		"smtp-worker",
		"imap:backfill-discover",
		{ identityId, workspaceId },
		{
			jobId: `imap-backfill-discover-${identityId}`,
			attempts: 3,
			backoff: { type: "exponential", delay: 1000 },
			removeOnComplete: true,
			// Deterministic jobId: a kept failed job would block every retry.
			removeOnFail: true,
		},
	);
	await queueImapBackfillAccount(identityId);
}

export async function queueImapBackfillAccount(identityId: string) {
	await addBulk("smtp-worker", [
		{
			name: "imap:backfill-account",
			data: { identityId },
			opts: {
				removeOnComplete: true,
				removeOnFail: true,
				jobId: `imap-backfill-account-${identityId}`,
			},
		},
		{
			name: "imap:start-idle",
			data: { identityId },
			opts: DEFAULT_JOB_OPTS,
		},
	]);
}

/** Gmail: discover the labels (waits), then backfill the account. */
export async function queueGmailBackfill(
	identityId: string,
	workspaceId: string,
) {
	await addJobAndWait(
		"gmail-worker",
		"gmail:backfill-discover",
		{ identityId, workspaceId },
		{
			jobId: `gmail-backfill-discover-${identityId}`,
			attempts: 3,
			backoff: { type: "exponential", delay: 1000 },
			removeOnComplete: true,
			removeOnFail: true,
		},
	);

	await getQueue("gmail-worker").add(
		"gmail:backfill-account",
		{ identityId, workspaceId },
		{
			jobId: `gmail-backfill-account-${identityId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
}

export async function queueStopIdle(identityId: string) {
	await getQueue("smtp-worker").add(
		"imap:stop-idle",
		{ identityId },
		DEFAULT_JOB_OPTS,
	);
}
