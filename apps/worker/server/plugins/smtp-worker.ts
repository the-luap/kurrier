import { db, identities } from "@db";
import { JobScheduler, Worker } from "bullmq";
import { and, eq, isNotNull } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { defineNitroPlugin } from "nitropack/runtime";
import { getRedis } from "../../lib/get-redis";
import { startFullBackfill } from "../../lib/imap/backfill/backfill-full";
import { discoverMailboxes } from "../../lib/imap/backfill/discover/discover-mailboxes";
import { initSmtpClient } from "../../lib/imap/imap-client";
import { deleteMail } from "../../lib/imap/imap-delete";
import { deleteFolder } from "../../lib/imap/imap-delete-folder";
import { deltaFetch } from "../../lib/imap/imap-delta-fetch";
import { mailSetFlags } from "../../lib/imap/imap-flags";
import {
	imapIdleSync,
	startRealtimeForIdentity,
	stopRealtimeForIdentity,
} from "../../lib/imap/imap-idle-sync";
import { moveMail } from "../../lib/imap/imap-move";
import { addNewFolder } from "../../lib/imap/imap-new-folder";

const DEFAULT_IMAP_POLL_INTERVAL_MS = 60 * 60 * 1000;
const MIN_IMAP_POLL_INTERVAL_MS = 5 * 60 * 1000;

function getImapPollIntervalMs() {
	const configured = Number(process.env.IMAP_POLL_INTERVAL_MS);
	if (!Number.isFinite(configured) || configured <= 0) {
		return DEFAULT_IMAP_POLL_INTERVAL_MS;
	}

	return Math.max(configured, MIN_IMAP_POLL_INTERVAL_MS);
}

async function deltaFetchAllIdentities(imapInstances: Map<string, ImapFlow>) {
	const identityRows = await db
		.select({ id: identities.id })
		.from(identities)
		.where(
			and(eq(identities.kind, "email"), isNotNull(identities.smtpAccountId)),
		);

	console.info("[imap:delta-fetch-all] polling identities", {
		count: identityRows.length,
	});

	for (const identity of identityRows) {
		await deltaFetch(identity.id, imapInstances).catch((err) => {
			console.error(
				`[imap:delta-fetch-all] failed for identityId ${identity.id}:`,
				err,
			);
		});
	}
}

export default defineNitroPlugin(async (nitroApp) => {
	console.info("**********************SMTP-WORKER***************************");

	const imapInstances = new Map<string, ImapFlow>();
	const idleImapInstances = new Map<string, ImapFlow>();
	const { connection, searchIngestQueue } = await getRedis();

	const worker = new Worker(
		"smtp-worker",
		async (job) => {
			if (job.name === "delta-fetch") {
				const identityId = job.data.identityId;
				await deltaFetch(identityId, imapInstances).catch((err) => {
					console.error(
						`delta-fetch job failed for identityId ${identityId}:`,
						err,
					);
				});
			} else if (job.name === "mail:move") {
				if (job.data.op === "move" && !job.data.toMailboxId) {
					throw new Error("mail:move requires toMailboxId when op === 'move'");
				}
				await moveMail(job.data, imapInstances);
				await searchIngestQueue.add(
					"refresh-thread",
					{ threadId: job.data.threadId },
					{
						jobId: `refresh-${job.data.threadId}`, // collapses duplicates
						removeOnComplete: true,
						removeOnFail: false,
						attempts: 3,
						backoff: { type: "exponential", delay: 1500 },
					},
				);
			} else if (job.name === "mail:set-flags") {
				await mailSetFlags(job.data, imapInstances);
				await searchIngestQueue.add(
					"refresh-thread",
					{ threadId: job.data.threadId },
					{
						jobId: `refresh-${job.data.threadId}`, // collapses duplicates
						removeOnComplete: true,
						removeOnFail: false,
						attempts: 3,
						backoff: { type: "exponential", delay: 1500 },
					},
				);
			} else if (job.name === "mail:delete-permanent") {
				await deleteMail(job.data, imapInstances);
			} else if (job.name === "smtp:append:sent") {
			} else if (job.name === "imap:delta-fetch-all") {
				console.info("IMAP scheduled delta fetch triggered");
				await deltaFetchAllIdentities(imapInstances);
				console.info("IMAP scheduled delta fetch completed");
				return { success: true };
			} else if (job.name === "imap:backfill-tick") {
				console.info(`IMAP Backfill Tick triggered`);
				await startFullBackfill(imapInstances).catch((err) => {
					console.error(`imap:backfill-tick job failed:`, err);
				});
				console.info("IMAP Backfill Tick completed");
				return { success: true };
			} else if (job.name === "imap:backfill-discover") {
				const identityId = job.data.identityId;
				const client = await initSmtpClient(identityId, imapInstances);
				if (client?.authenticated && client?.usable) {
					await discoverMailboxes(client, identityId);
				}
			} else if (job.name === "mailbox:add-new") {
				const identityId = job.data.identityId;
				const client = await initSmtpClient(identityId, imapInstances);
				if (client) {
					await addNewFolder(job.data, client);
				}
			} else if (job.name === "mailbox:delete-folder") {
				const identityId = job.data.identityId;
				const client = await initSmtpClient(identityId, imapInstances);
				if (client) {
					await deleteFolder(job.data, client);
				}
			} else if (job.name === "imap:start-idle") {
				const identityId = job.data.identityId as string;
				await startRealtimeForIdentity(
					identityId,
					idleImapInstances,
					imapInstances,
				);
			} else if (job.name === "imap:stop-idle") {
				const identityId = job.data.identityId as string;
				await stopRealtimeForIdentity(
					identityId,
					idleImapInstances,
					imapInstances,
				);
			}
			return { success: true };
		},
		{ connection },
	);

	await imapIdleSync(idleImapInstances, imapInstances);

	const scheduler = new JobScheduler("smtp-worker", { connection });
	const imapPollIntervalMs = getImapPollIntervalMs();

	await scheduler.upsertJobScheduler(
		"imap-delta-fetch-all-scheduler",
		{ every: imapPollIntervalMs },
		"imap:delta-fetch-all",
		{},
		{
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 5000 },
		},
		{ override: true },
	);

	console.info("IMAP scheduled delta fetch configured", {
		intervalMs: imapPollIntervalMs,
	});

	await deltaFetchAllIdentities(imapInstances).catch((err) => {
		console.error("Initial IMAP scheduled delta fetch failed", err);
	});

	await scheduler.upsertJobScheduler(
		"imap-backfill-scheduler",
		{ every: 120000 },
		"imap:backfill-tick",
		{},
		{
			removeOnComplete: true,
			removeOnFail: true,
			attempts: 1,
			backoff: { type: "fixed", delay: 5000 },
		},
		{ override: true },
	);

	worker.on("completed", async (job) => {
		console.info("job", job.name);
		console.info(`[SMTP] ${job.id} has completed!`);
	});

	worker.on("failed", (job, err) => {
		console.info(`${job?.id} has failed with ${err.message}`);
	});
	worker.on("error", (err) => {
		console.info(`[SMTP] worker has failed with ${err.message}`);
	});

	nitroApp.hooks.hookOnce("close", async () => {
		console.info("Closing nitro server...");
		try {
			const logoutAll = async (label: string, map: Map<string, ImapFlow>) => {
				for (const [identityId, client] of map) {
					try {
						await client.logout();
						console.info(
							`[${label}] Logged out from IMAP server for identityId: ${identityId}`,
						);
					} catch (err) {
						console.error(
							`[${label}] Failed to logout cleanly for identityId: ${identityId}`,
							err,
						);
					}
				}
				map.clear();
				console.info(`[${label}] IMAP map cleared`);
			};

			await logoutAll("command", imapInstances);
			await logoutAll("realtime", idleImapInstances);
			console.info("Logged out from IMAP server");

			for (const schedulerId of [
				"imap-delta-fetch-all-scheduler",
				"imap-backfill-scheduler",
			]) {
				try {
					await scheduler.removeJobScheduler(schedulerId);
				} catch (err) {
					const message = err instanceof Error ? err.message : err;
					console.error(`Error removing ${schedulerId}:`, message);
				}
			}
		} catch (err) {
			console.error("Failed to logout cleanly", err);
		}
		console.info("Task is done!");
	});
});
