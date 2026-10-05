import { db, mailboxes, messages, mailboxThreads } from "@db";
import { upsertMailboxThreadItem } from "@common";
import { and, eq, sql } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { initSmtpClient } from "./imap-client";

type MoveJob = {
	threadId: string;
	mailboxId: string; // source
	op: "trash" | "archive" | "spam" | "move";
	toMailboxId?: string; // required when op === "move"
	moveImap: boolean;
	messageId?: string;
};

export const moveMail = async (
	data: MoveJob,
	imapInstances: Map<string, ImapFlow>,
) => {
	const {
		threadId,
		mailboxId: fromMailboxId,
		op,
		toMailboxId,
		moveImap,
		messageId,
	} = data;

	// Source mailbox
	const [srcMailbox] = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, fromMailboxId));
	if (!srcMailbox) return;

	// Destination mailbox
	let destMailboxRow: typeof mailboxes.$inferSelect | undefined;

	if (op === "move") {
		if (!toMailboxId || toMailboxId === fromMailboxId) return;
		[destMailboxRow] = await db
			.select()
			.from(mailboxes)
			.where(
				and(
					eq(mailboxes.id, toMailboxId),
					eq(mailboxes.identityId, srcMailbox.identityId),
				),
			);
	} else {
		[destMailboxRow] = await db
			.select()
			.from(mailboxes)
			.where(
				and(
					eq(mailboxes.identityId, srcMailbox.identityId),
					eq(mailboxes.kind, op as any),
				),
			);
	}

	if (!destMailboxRow) {
		console.warn(
			`[mail:move] No destination for op=${op} identity=${srcMailbox.identityId}`,
		);
		return;
	}

	const destPath: string =
		(destMailboxRow.metaData as any)?.imap?.path ?? destMailboxRow.name;

	// Messages in thread scoped to the source mailbox (only the one message
	// for a single-message action).
	const sourceScope = and(
		eq(messages.threadId, threadId),
		eq(messages.mailboxId, fromMailboxId),
		messageId ? eq(messages.id, messageId) : undefined,
	);
	const threadMsgs = await db
		.select({ id: messages.id, meta: messages.metaData })
		.from(messages)
		.where(sourceScope);
	if (threadMsgs.length === 0) return;

	if (moveImap) {
		type Group = { path: string; uids: number[]; messageIds: string[] };
		const byPath = new Map<string, Group>();

		for (const m of threadMsgs) {
			const im = (m.meta as any)?.imap;
			const uid = im?.uid as number | undefined;
			const srcPath = im?.mailboxPath as string | undefined;
			if (!uid || !srcPath) continue;
			const g = byPath.get(srcPath) ?? {
				path: srcPath,
				uids: [],
				messageIds: [],
			};
			g.uids.push(Number(uid));
			g.messageIds.push(m.id);
			byPath.set(srcPath, g);
		}

		if (!byPath.size) {
			console.debug(
				"[mail:move] No IMAP-backed UIDs to move; DB-only move will proceed.",
			);
		} else {
			const client = await initSmtpClient(srcMailbox.identityId, imapInstances);
			if (client?.authenticated && client.usable) {
				try {
					for (const { path: srcPath, uids } of byPath.values()) {
						if (!uids.length) continue;
						const lock = await client.getMailboxLock(srcPath);
						try {
							await client.messageMove(uids, destPath, { uid: true });
						} finally {
							lock.release();
						}
					}
				} catch (err) {
					console.error("[mail:move] IMAP move failed:", err);
					// Let DB update happen; delta sync can reconcile.
				}
			}
		}
	}

	// DB update
	await db.transaction(async (tx) => {
		const set: Record<string, any> = {
			mailboxId: destMailboxRow.id,
			updatedAt: new Date(),
		};
		if (moveImap) {
			set.metaData = sql`
        jsonb_set(
          coalesce(${messages.metaData}, '{}'::jsonb),
          '{imap,mailboxPath}',
          to_jsonb(${destPath}::text),
          true
        )
      `;
		}

		await tx.update(messages).set(set).where(sourceScope);

		if (messageId) {
			await moveSingleMessageSummary(tx, {
				threadId,
				fromMailboxId,
				messageId,
			});
			return;
		}

		await tx
			.update(mailboxThreads)
			.set({
				mailboxId: destMailboxRow.id,
				mailboxSlug: op === "move" ? (destMailboxRow.slug ?? "custom") : op,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(mailboxThreads.threadId, threadId),
					eq(mailboxThreads.mailboxId, fromMailboxId),
				),
			);
	});
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * After one message of a thread moved: the destination row gains it (upsert
 * aggregates the destination mailbox's messages of the thread), and the
 * source row is recomputed from what is left there, or removed when nothing
 * is left.
 */
async function moveSingleMessageSummary(
	tx: Tx,
	{
		threadId,
		fromMailboxId,
		messageId,
	}: { threadId: string; fromMailboxId: string; messageId: string },
) {
	await upsertMailboxThreadItem(messageId, tx);

	const remaining = sql`
		select ${messages.id} as id, ${messages.seen} as seen,
			${messages.flagged} as flagged,
			${messages.hasAttachments} as has_attachments,
			coalesce(${messages.date}, ${messages.createdAt}) as at
		from ${messages}
		where ${messages.threadId} = ${threadId}
			and ${messages.mailboxId} = ${fromMailboxId}
	`;

	const [{ left }] = await tx
		.select({ left: sql<number>`count(*)::int` })
		.from(messages)
		.where(
			and(
				eq(messages.threadId, threadId),
				eq(messages.mailboxId, fromMailboxId),
			),
		);

	if (!left) {
		await tx
			.delete(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.threadId, threadId),
					eq(mailboxThreads.mailboxId, fromMailboxId),
				),
			);
		return;
	}

	// Exact recompute: upsertMailboxThreadItem only ever grows the timeline
	// and the starred/attachment flags, which is wrong after a removal.
	await tx
		.update(mailboxThreads)
		.set({
			messageCount: sql`(select count(*) from (${remaining}) r)`,
			unreadCount: sql`(select count(*) filter (where not r.seen) from (${remaining}) r)`,
			starred: sql`(select coalesce(bool_or(r.flagged), false) from (${remaining}) r)`,
			hasAttachments: sql`(select coalesce(bool_or(r.has_attachments), false) from (${remaining}) r)`,
			lastActivityAt: sql`(select max(r.at) from (${remaining}) r)`,
			firstMessageAt: sql`(select min(r.at) from (${remaining}) r)`,
			previewText: sql`coalesce((
				select ${messages.snippet} from ${messages}
				where ${messages.id} = (select r.id from (${remaining}) r order by r.at desc limit 1)
			), ${mailboxThreads.previewText})`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(mailboxThreads.threadId, threadId),
				eq(mailboxThreads.mailboxId, fromMailboxId),
			),
		);
}
