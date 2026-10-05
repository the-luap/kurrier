import type { JobsOptions } from "bullmq";
import { getQueue, RETRY_JOB_OPTS } from "@/lib/actions/get-redis";

/** Normalize the "one id or many" argument of the mail actions. */
export const toIdList = (ids: string | string[] | null | undefined) =>
	(Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);

/**
 * Queue one smtp-worker job per thread. addBulk sends all jobs in one
 * Redis MULTI instead of one round trip per thread.
 */
export function enqueueThreadSmtpJobs(
	jobName: string,
	threadIds: string[],
	data: (threadId: string) => Record<string, unknown>,
	opts: (threadId: string) => JobsOptions = () => ({
		...RETRY_JOB_OPTS,
		removeOnComplete: true,
		removeOnFail: false,
	}),
) {
	if (!threadIds.length) return Promise.resolve([]);
	return getQueue("smtp-worker").addBulk(
		threadIds.map((threadId) => ({
			name: jobName,
			data: { threadId, ...data(threadId) },
			opts: opts(threadId),
		})),
	);
}

/** Re-index threads in Typesense (deduplicated per thread by jobId). */
export function enqueueSearchRefresh(threadIds: string[]) {
	if (!threadIds.length) return Promise.resolve([]);
	return getQueue("search-ingest").addBulk(
		threadIds.map((threadId) => ({
			name: "refresh-thread",
			data: { threadId },
			opts: {
				...RETRY_JOB_OPTS,
				jobId: `refresh-${threadId}`,
				removeOnComplete: true,
				removeOnFail: false,
			},
		})),
	);
}
