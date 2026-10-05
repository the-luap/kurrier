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
import { syncMailbox } from "./imap-sync-mailbox";
import { upsertMailboxThreadItem } from "@common";
import { enqueueThreadRefresh } from "../../lib/get-redis";

// One delta fetch per identity at a time. IDLE "exists" events and
// delta-fetch jobs share the same IMAP client; running them concurrently
// raced on the selected mailbox and inserted the same messages twice.
// Calls arriving while a fetch runs are coalesced into one follow-up run.
const running = new Map<string, Promise<void>>();
const rerunRequested = new Set<string>();

/**
 * Incremental sync for all mailboxes of an identity.
 * - Skips mailboxes that are backfilling / not idle
 * - Inserts new messages
 * - Detects cross-mailbox moves and updates:
 *     * messages.mailboxId + metaData.imap.mailboxPath for all msgs in the thread
 *     * threads.mailboxId
 *     * mailboxThreads (re-upsert from newest msg)
 *     * search index (refresh-thread)
 */
export const deltaFetch = (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
): Promise<void> => {
	const current = running.get(identityId);
	if (current) {
		rerunRequested.add(identityId);
		return current;
	}

	const run = (async () => {
		try {
			do {
				rerunRequested.delete(identityId);
				await deltaFetchOnce(identityId, imapInstances);
			} while (rerunRequested.has(identityId));
		} finally {
			running.delete(identityId);
			// If a run failed while new mail was announced, don't drop that
			// request: start one more run (it fails or succeeds on its own).
			if (rerunRequested.delete(identityId)) {
				queueMicrotask(() => {
					deltaFetch(identityId, imapInstances).catch((error) =>
						console.error("[delta-fetch] follow-up run failed", error),
					);
				});
			}
		}
	})();
	running.set(identityId, run);
	return run;
};

const deltaFetchOnce = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) => {
	const client = await initSmtpClient(identityId, imapInstances);
	if (!client?.authenticated || !client?.usable) return;

	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, identityId));
	const ownerId = identity?.ownerId;
	if (!ownerId) return;

	const mailboxRows = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.identityId, identityId));

	// One query for all sync rows instead of one per mailbox.
	const syncedMailboxIds = new Set(
		(
			await db
				.select({ mailboxId: mailboxSync.mailboxId })
				.from(mailboxSync)
				.where(eq(mailboxSync.identityId, identityId))
		).map((r) => r.mailboxId),
	);

	const knownMessageIds = new Set<string>();

	for (const row of mailboxRows) {
		if (!syncedMailboxIds.has(row.id)) continue;
		// if (syncRow.phase !== "IDLE" || Number(syncRow.backfillCursorUid || 0) > 0)
		// 	continue;

		await syncMailbox({
			client,
			identityId,
			mailboxId: row.id,
			path: String((row?.metaData as any)?.imap?.path ?? row.name),
			window: 500,
			// Messages whose Message-ID is already stored (moves, duplicates)
			// are handled from their envelope: their source is not downloaded,
			// and new messages skip the per-message existence query below.
			selectSkipSource: async (headers) => {
				knownMessageIds.clear();
				const ids = [
					...new Set(
						headers
							.map((h) => h.envelope?.messageId?.trim())
							.filter((id): id is string => !!id),
					),
				];
				if (!ids.length) return new Set<number>();
				const known = await db
					.select({ messageId: messages.messageId })
					.from(messages)
					.where(
						and(
							eq(messages.ownerId, ownerId),
							inArray(messages.messageId, ids),
						),
					);
				for (const k of known) knownMessageIds.add(k.messageId);
				const skip = new Set<number>();
				for (const h of headers) {
					const id = h.envelope?.messageId?.trim();
					if (id && h.uid && knownMessageIds.has(id)) skip.add(h.uid);
				}
				return skip;
			},
			onMessage: async (msg, path: string) => {
				const messageId = msg.envelope?.messageId?.trim() || null;
				const uid = msg.uid;
				const raw = (await msg.source?.toString()) || "";

				const flags = msg.flags ?? new Set<string>();
				const isSeen = flags.has("\\Seen");
				const isFlagged = flags.has("\\Flagged");
				const isAnswered = flags.has("\\Answered");

				if (!messageId) {
					console.warn(
						`[deltaFetch] Missing Message-ID — path=${path} uid=${uid}`,
					);
					return await parseAndStoreEmail(raw, {
						ownerId,
						mailboxId: row.id,
						rawStorageKey: `eml/${ownerId}/${row.id}/${uid}.eml`,
						emlKey: String(msg.id),
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
					});
				}

				// Not known when the window was checked: a new message.
				const [existing] = !knownMessageIds.has(messageId)
					? []
					: await db
							.select({
								id: messages.id,
								mailboxId: messages.mailboxId,
								threadId: messages.threadId,
							})
							.from(messages)
							.where(
								and(
									eq(messages.ownerId, ownerId),
									eq(messages.messageId, messageId),
								),
							);

				if (existing) {
					if (existing.mailboxId !== row.id) {
						console.log(
							`[deltaFetch] Move detected for ${messageId}: ${existing.mailboxId} → ${row.id}`,
						);

						const all = await db
							.select({
								id: messages.id,
								mailboxId: messages.mailboxId,
								metaData: messages.metaData,
								messageId: messages.messageId,
							})
							.from(messages)
							.where(
								and(
									eq(messages.threadId, existing.threadId),
									eq(messages.mailboxId, existing.mailboxId),
								),
							);

						// Messages already present in the destination mailbox, looked up
						// in one query instead of one per thread message.
						const candidateIds = all
							.filter((m) => m.mailboxId !== row.id)
							.map((m) => m.messageId);
						const dupMessageIds = new Set(
							candidateIds.length
								? (
										await db
											.select({ messageId: messages.messageId })
											.from(messages)
											.where(
												and(
													eq(messages.ownerId, ownerId),
													eq(messages.mailboxId, row.id),
													inArray(messages.messageId, candidateIds),
												),
											)
									).map((d) => d.messageId)
								: [],
						);

						for (const m of all) {
							if (m.mailboxId === row.id) continue;

							if (dupMessageIds.has(m.messageId)) {
								await db.delete(messages).where(eq(messages.id, m.id));
								continue;
							}

							const updatedMeta = {
								...(m.metaData as any),
								imap: {
									...((m.metaData as any)?.imap || {}),
									mailboxPath: path,
								},
							};

							await db
								.update(messages)
								.set({ mailboxId: row.id, metaData: updatedMeta })
								.where(eq(messages.id, m.id))
								.catch((e) =>
									console.error("[deltaFetch] failed message move update", e),
								);
						}

						await db
							.delete(mailboxThreads)
							.where(eq(mailboxThreads.threadId, existing.threadId));

						const [newest] = await db
							.select({ id: messages.id })
							.from(messages)
							.where(eq(messages.threadId, existing.threadId))
							.orderBy(
								desc(sql`coalesce(${messages.date}, ${messages.createdAt})`),
							)
							.limit(1);

						if (newest?.id) {
							await upsertMailboxThreadItem(newest.id).catch((e) =>
								console.error("[deltaFetch] upsertMailboxThreadItem failed", e),
							);
						}

						try {
							await enqueueThreadRefresh(existing.threadId);
						} catch (e) {
							console.warn("[deltaFetch] enqueue refresh-thread failed", e);
						}

						return;
					}

					return;
				}

				let source = raw;
				if (!source && uid) {
					// Skipped as known in the envelope pass, but the row is gone by
					// now (e.g. deleted meanwhile): download it after all, otherwise
					// lastSeenUid moves past it and it is never imported. Skipped
					// messages are handled outside the fetch iterator, so another
					// command is safe here.
					const full = await client.fetchOne(
						String(uid),
						{ source: true },
						{ uid: true },
					);
					source = full ? full.source?.toString() || "" : "";
				}
				if (!source) {
					console.warn(
						`[deltaFetch] No source for ${messageId} — path=${path} uid=${uid}`,
					);
					return;
				}

				await parseAndStoreEmail(source, {
					ownerId,
					mailboxId: row.id,
					rawStorageKey: `eml/${ownerId}/${row.id}/${uid}.eml`,
					emlKey: String(msg.id),
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
				});

				return undefined as any;
			},
		});
	}
};
