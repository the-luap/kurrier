import {
	db,
	identities,
	mailboxes,
	mailboxSync,
	messages,
	mailboxThreads,
} from "@db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { parseAndStoreEmail } from "../message-payload-parser";
import { initSmtpClient } from "./imap-client";
import type { ImapFlow } from "imapflow";
import { NEEDS_SOURCE, syncMailbox } from "./imap-sync-mailbox";
import { upsertMailboxThreadItem } from "@common";
import { getRedis } from "../../lib/get-redis";
import { canSyncIdentity } from "../access";

/**
 * Prevent more than one delta sync from running for the same
 * identity inside this worker process.
 *
 * This protects against:
 * - multiple EXISTS events arriving quickly
 * - manual delta overlapping an EXISTS-triggered delta
 * - duplicate BullMQ work inside the same process
 */
const runningDeltaFetches = new Map<string, Promise<void>>();

/**
 * Calls arriving while a delta runs (e.g. an EXISTS for mail that arrived
 * after its mailbox was already scanned) are coalesced into one follow-up
 * run instead of only joining the running sync.
 */
const rerunRequested = new Set<string>();

async function runDeltaFetch(
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) {
	const client = await initSmtpClient(identityId, imapInstances);

	if (!client?.authenticated || !client?.usable) {
		console.warn(
			`[deltaFetch:${identityId}] IMAP client not usable`,
		);
		return;
	}

	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, identityId))
		.limit(1);

	const ownerId = identity?.ownerId;
	const workspaceId = identity?.workspaceId;

	if (!ownerId || !workspaceId) {
		console.warn(
			`[deltaFetch:${identityId}] identity missing owner/workspace`,
		);
		return;
	}

	const mailboxRows = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.identityId, identityId));
	const identityMailboxIds = mailboxRows.map((m) => m.id);
	const mailboxById = new Map(mailboxRows.map((m) => [m.id, m]));

	// Folders that hold additional copies of messages stored elsewhere
	// (Gmail "All Mail", Sent copies of mail sent to oneself, ...): a
	// Message-ID seen there is not a move.
	const isCopyFolder = (m: (typeof mailboxRows)[number] | undefined) => {
		const su = String((m?.metaData as any)?.imap?.specialUse ?? "").toLowerCase();
		return su === "\\all" || su === "\\sent" || su === "\\flagged" || su === "\\important";
	};

	for (const row of mailboxRows) {
		// Folders deleted / renamed on the server (discover marks them).
		if ((row.metaData as any)?.imap?.selectable === false) continue;

		const [syncRow] = await db
			.select()
			.from(mailboxSync)
			.where(
				and(
					eq(mailboxSync.identityId, identityId),
					eq(mailboxSync.mailboxId, row.id),
				),
			)
			.limit(1);

		if (!syncRow) {
			continue;
		}

		const path = String(
			(row.metaData as any)?.imap?.path ?? row.name,
		);

		if (!path) {
			continue;
		}

		try {
		await syncMailbox({
			client,
			identityId,
			workspaceId,
			mailboxId: row.id,
			path,
			window: 500,

			onMessage: async (
				msg,
				path: string,
			): Promise<void | typeof NEEDS_SOURCE> => {
				const messageId =
					msg.envelope?.messageId?.trim() || null;

				const uid = msg.uid;

				// Pass 1 fetches envelopes only; the source is downloaded in a
				// second pass for messages that have to be stored.
				const hasSource = Boolean(msg.source);
				// Raw bytes: parseAndStoreEmail decodes the charsets itself.
				const raw = msg.source ?? Buffer.alloc(0);

				const flags =
					msg.flags ?? new Set<string>();

				const isSeen =
					flags.has("\\Seen");

				const isFlagged =
					flags.has("\\Flagged");

				const isAnswered =
					flags.has("\\Answered");

				if (!messageId) {
					if (!hasSource) return NEEDS_SOURCE;
					console.warn(
						`[deltaFetch] Missing Message-ID — path=${path} uid=${uid}`,
					);

					await parseAndStoreEmail(
						raw,
						{
							ownerId,
							workspaceId,
							mailboxId: row.id,

							rawStorageKey:
								`eml/${ownerId}/${row.id}/${msg.id}.eml`,

							emlKey:
								String(msg.id),

							metaData: {
								imap: {
									uid,
									mailboxPath: path,
									flags: [...flags],
								},
							},

							seen: isSeen,
							flagged: isFlagged,
							answered: isAnswered,
						},
					);

					return;
				}

				// Already stored in this folder: refresh UID / path / flags
				// (UIDVALIDITY replay, message moved here by Kurrier).
				const [here] = await db
					.select({
						id: messages.id,
						seen: messages.seen,
						flagged: messages.flagged,
					})
					.from(messages)
					.where(
						and(
							eq(messages.mailboxId, row.id),
							eq(messages.messageId, messageId),
						),
					)
					.limit(1);

				if (here) {
					await db
						.update(messages)
						.set({
							metaData: sql`jsonb_set(coalesce(${messages.metaData}, '{}'::jsonb), '{imap}', coalesce(${messages.metaData} -> 'imap', '{}'::jsonb) || ${JSON.stringify({ uid, mailboxPath: path, flags: [...flags] })}::jsonb, true)`,
							seen: isSeen,
							flagged: isFlagged,
							answered: isAnswered,
							updatedAt: new Date(),
						})
						.where(eq(messages.id, here.id));
					if (here.seen !== isSeen || here.flagged !== isFlagged) {
						await upsertMailboxThreadItem(here.id).catch((e) =>
							console.error("[deltaFetch] upsertMailboxThreadItem failed", e),
						);
					}
					return;
				}

				// Only this identity's folders: the same mail delivered to two
				// identities of one user is not a move between them.
				const [existing] = await db
					.select({
						id: messages.id,
						mailboxId: messages.mailboxId,
						threadId: messages.threadId,
					})
					.from(messages)
					.where(
						and(
							eq(
								messages.ownerId,
								ownerId,
							),
							eq(
								messages.messageId,
								messageId,
							),
							inArray(messages.mailboxId, identityMailboxIds),
						),
					)
					.limit(1);

				if (
					existing &&
					!isCopyFolder(row) &&
					!isCopyFolder(mailboxById.get(existing.mailboxId))
				) {
					if (
						existing.mailboxId !== row.id
					) {
						console.log(
							`[deltaFetch] Move detected for ${messageId}: ${existing.mailboxId} → ${row.id}`,
						);

						const all = await db
							.select({
								id: messages.id,
								mailboxId:
								messages.mailboxId,
								metaData:
								messages.metaData,
								messageId:
								messages.messageId,
							})
							.from(messages)
							// Only the moved message, not every message of its thread
							// in the old folder.
							.where(eq(messages.id, existing.id));

						for (const m of all) {
							if (
								m.mailboxId === row.id
							) {
								continue;
							}

							const [dup] =
								await db
									.select({
										id:
										messages.id,
									})
									.from(messages)
									.where(
										and(
											eq(
												messages.ownerId,
												ownerId,
											),
											eq(
												messages.messageId,
												m.messageId,
											),
											eq(
												messages.mailboxId,
												row.id,
											),
										),
									)
									.limit(1);

							if (dup?.id) {
								await db
									.delete(messages)
									.where(
										eq(
											messages.id,
											m.id,
										),
									);

								continue;
							}

							const updatedMeta = {
								...(m.metaData as any),

								imap: {
									...(
										(m.metaData as any)
											?.imap || {}
									),

									mailboxPath:
									path,
									uid,
									flags: [...flags],
								},
							};

							await db
								.update(messages)
								.set({
									mailboxId:
									row.id,

									metaData:
									updatedMeta,
								})
								.where(
									eq(
										messages.id,
										m.id,
									),
								)
								.catch((e) =>
									console.error(
										"[deltaFetch] failed message move update",
										e,
									),
								);
						}

						// Recompute only the two folders involved: deleting every
						// mailbox_threads row of the thread dropped it from Sent and
						// other folders that still hold messages of it.
						const touchedMailboxIds = [existing.mailboxId, row.id];
						await db
							.delete(mailboxThreads)
							.where(
								and(
									eq(mailboxThreads.threadId, existing.threadId),
									inArray(mailboxThreads.mailboxId, touchedMailboxIds),
								),
							);

						for (const mailboxIdToSum of touchedMailboxIds) {
							const [newest] = await db
								.select({ id: messages.id })
								.from(messages)
								.where(
									and(
										eq(messages.threadId, existing.threadId),
										eq(messages.mailboxId, mailboxIdToSum),
									),
								)
								.orderBy(
									desc(sql`coalesce(${messages.date}, ${messages.createdAt})`),
								)
								.limit(1);

							if (newest?.id) {
								await upsertMailboxThreadItem(newest.id).catch((e) =>
									console.error(
										"[deltaFetch] upsertMailboxThreadItem failed",
										e,
									),
								);
							}
						}

						try {
							const {
								searchIngestQueue,
							} = await getRedis();

							await searchIngestQueue.add(
								"refresh-thread",
								{
									threadId:
									existing.threadId,
								},
								{
									jobId:
										`refresh-${existing.threadId}`,

									attempts: 3,

									backoff: {
										type:
											"exponential",
										delay: 1500,
									},

									removeOnComplete:
										true,

									removeOnFail:
										true,
								},
							);
						} catch (e) {
							console.warn(
								"[deltaFetch] enqueue refresh-thread failed",
								e,
							);
						}

						return;
					}

					return;
				}

				if (!hasSource) return NEEDS_SOURCE;

				await parseAndStoreEmail(
					raw,
					{
						ownerId,
						workspaceId,
						mailboxId: row.id,

						rawStorageKey:
							`eml/${ownerId}/${row.id}/${msg.id}.eml`,

						emlKey:
							String(msg.id),

						metaData: {
							imap: {
								uid,
								mailboxPath: path,
								flags: [...flags],
							},
						},

						seen: isSeen,
						flagged: isFlagged,
						answered: isAnswered,
					},
				);
			},
		});
		} catch (err: any) {
			// One failing (deleted / renamed) folder must not stop the sync
			// of every folder after it.
			if (!client.usable) throw err;
			console.error(
				`[deltaFetch:${identityId}] mailbox ${path} failed`,
				err?.message ?? err,
			);
		}
	}
}

/**
 * Public delta entry point.
 *
 * If a delta is already running for this identity, reuse the same
 * promise instead of starting another sync against the same cursor.
 */
export const deltaFetch = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) => {
	if (!(await canSyncIdentity(identityId))) {
		console.info(
			`[IMAP] delta sync disabled identity=${identityId}`,
		);
		return;
	}

	const existing =
		runningDeltaFetches.get(identityId);

	if (existing) {
		console.log(
			`[deltaFetch:${identityId}] already running; joining existing sync and scheduling a follow-up run`,
		);

		rerunRequested.add(identityId);
		return existing;
	}

	const runLoop = async () => {
		do {
			rerunRequested.delete(identityId);
			await runDeltaFetch(identityId, imapInstances);
		} while (rerunRequested.has(identityId));
	};

	const running = runLoop().finally(() => {
		if (
			runningDeltaFetches.get(identityId) ===
			running
		) {
			runningDeltaFetches.delete(identityId);
		}

		// If a run failed while new mail was announced, don't drop that
		// request: start a fresh run.
		if (rerunRequested.delete(identityId)) {
			queueMicrotask(() => {
				deltaFetch(identityId, imapInstances).catch((error) =>
					console.error(
						`[deltaFetch:${identityId}] follow-up run failed`,
						error,
					),
				);
			});
		}
	});

	runningDeltaFetches.set(
		identityId,
		running,
	);

	return running;
};
