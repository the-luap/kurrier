import { FetchMessageObject, ImapFlow } from "imapflow";
import { db, mailboxSync } from "@db";
import { and, eq } from "drizzle-orm";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compacts ascending UIDs into an IMAP sequence set ("1:3,7,9:10"). */
function toUidSet(uids: number[]): string {
	const sorted = [...uids].sort((a, b) => a - b);
	const parts: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let i = 1; i <= sorted.length; i++) {
		const uid = sorted[i];
		if (uid === prev + 1) {
			prev = uid;
			continue;
		}
		parts.push(start === prev ? String(start) : `${start}:${prev}`);
		start = uid;
		prev = uid;
	}
	return parts.join(",");
}
export async function syncMailbox(opts: {
	client: ImapFlow;
	identityId: string;
	mailboxId: string;
	path: string;
	window?: number;
	politeWaitMs?: number;
	onMessage: (
		msg: FetchMessageObject,
		path: string,
		identityId: string,
		mailboxId: string,
	) => Promise<void>;
	/**
	 * Optional: given the envelopes of a window, return the UIDs whose full
	 * source is not needed. Those are passed to onMessage without `source`,
	 * so already known (e.g. moved) messages are not downloaded again.
	 */
	selectSkipSource?: (msgs: FetchMessageObject[]) => Promise<Set<number>>;
}) {
	const {
		client,
		identityId,
		mailboxId,
		path,
		window = 500,
		politeWaitMs = 20,
		onMessage,
		selectSkipSource,
	} = opts;

	const lock = await client.getMailboxLock(path);
	try {
		const [sync] = await db
			.select()
			.from(mailboxSync)
			.where(
				and(
					eq(mailboxSync.identityId, identityId),
					eq(mailboxSync.mailboxId, mailboxId),
				),
			);
		if (!sync)
			throw new Error(`mailbox_sync row missing for mailboxId=${mailboxId}`);

		let lastSeen = Number(sync.lastSeenUid || 0);

		const box = await client.mailboxOpen(path, { readOnly: true });
		const currentTop = Math.max(0, (box.uidNext ?? 1) - 1);
		if (currentTop <= lastSeen) return; // nothing new

		let start = lastSeen + 1;
		while (start <= currentTop) {
			const end = Math.min(currentTop, start + window - 1);
			const range = `${start}:${end}`;

			let maxUid = lastSeen;

			if (selectSkipSource) {
				// Pass 1: envelopes only (cheap) to decide what must be downloaded.
				const headers: FetchMessageObject[] = [];
				for await (const msg of client.fetch(
					{ uid: range },
					{
						uid: true,
						envelope: true,
						flags: true,
						internalDate: true,
						size: true,
					},
				)) {
					headers.push(msg);
				}

				const skip = await selectSkipSource(headers);
				const toDownload: number[] = [];
				for (const msg of headers) {
					if (msg.uid && msg.uid > maxUid) maxUid = msg.uid;
					if (msg.uid && skip.has(msg.uid)) {
						await onMessage(msg, path, identityId, mailboxId);
					} else if (msg.uid) {
						toDownload.push(msg.uid);
					}
				}

				// Pass 2: full source only for the messages that need it.
				if (toDownload.length) {
					for await (const msg of client.fetch(
						toUidSet(toDownload),
						{
							uid: true,
							envelope: true,
							flags: true,
							internalDate: true,
							size: true,
							source: true,
						},
						{ uid: true },
					)) {
						await onMessage(msg, path, identityId, mailboxId);
						if (msg.uid && msg.uid > maxUid) maxUid = msg.uid;
					}
				}
			} else {
				for await (const msg of client.fetch(
					{ uid: range },
					{
						uid: true,
						envelope: true,
						flags: true,
						internalDate: true,
						size: true,
						source: true,
					},
				)) {
					await onMessage(msg, path, identityId, mailboxId);
					if (msg.uid && msg.uid > maxUid) maxUid = msg.uid;
				}
			}

			if (maxUid > lastSeen) {
				lastSeen = maxUid;
				await db
					.update(mailboxSync)
					.set({ lastSeenUid: lastSeen, updatedAt: new Date() })
					.where(eq(mailboxSync.id, sync.id));
			}

			start = end + 1;
			if (politeWaitMs) await sleep(politeWaitMs);
		}

		await db
			.update(mailboxSync)
			.set({ phase: "IDLE", syncedAt: new Date(), updatedAt: new Date() })
			.where(eq(mailboxSync.id, sync.id));
	} finally {
		lock.release();
	}
}
