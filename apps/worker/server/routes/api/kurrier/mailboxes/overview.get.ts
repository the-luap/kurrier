import { db, identities, mailboxes, mailboxThreads } from "@db";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { defineEventHandler } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";

type MailboxOverview = typeof mailboxes.$inferSelect & {
	unreadCount: number;
	unreadThreads: number;
	totalThreads: number;
	recentThreads: (typeof mailboxThreads.$inferSelect)[];
};

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);

	const rows = await db
		.select({ identity: identities, mailbox: mailboxes })
		.from(identities)
		.leftJoin(mailboxes, eq(identities.id, mailboxes.identityId))
		.where(and(eq(identities.ownerId, ownerId), eq(identities.kind, "email")))
		.orderBy(asc(identities.value), asc(mailboxes.name));

	const mailboxIds = rows.flatMap((row) =>
		row.mailbox ? [row.mailbox.id] : [],
	);
	const unreadAgg = mailboxIds.length
		? await db
				.select({
					mailboxId: mailboxThreads.mailboxId,
					unreadThreads:
						sql<number>`count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)`.as(
							"unread_threads",
						),
					unreadTotal:
						sql<number>`coalesce(sum(${mailboxThreads.unreadCount}), 0)`.as(
							"unread_total",
						),
					totalThreads: sql<number>`count(*)`.as("total_threads"),
				})
				.from(mailboxThreads)
				.where(
					and(
						eq(mailboxThreads.ownerId, ownerId),
						inArray(mailboxThreads.mailboxId, mailboxIds),
					),
				)
				.groupBy(mailboxThreads.mailboxId)
		: [];

	const now = new Date();
	const inboxIds = rows.flatMap((row) =>
		row.mailbox?.kind === "inbox" ? [row.mailbox.id] : [],
	);
	const recentRows = inboxIds.length
		? await db
				.select()
				.from(mailboxThreads)
				.where(
					and(
						eq(mailboxThreads.ownerId, ownerId),
						inArray(mailboxThreads.mailboxId, inboxIds),
						gt(mailboxThreads.unreadCount, 0),
						or(
							isNull(mailboxThreads.snoozedUntil),
							lte(mailboxThreads.snoozedUntil, now),
						),
					),
				)
				.orderBy(desc(mailboxThreads.lastActivityAt))
				.limit(Math.min(inboxIds.length * 3, 150))
		: [];

	const aggByMailbox = new Map(unreadAgg.map((a) => [a.mailboxId, a]));
	const recentByMailbox = new Map<string, typeof recentRows>();
	for (const thread of recentRows) {
		const list = recentByMailbox.get(thread.mailboxId) ?? [];
		if (list.length < 3) list.push(thread);
		recentByMailbox.set(thread.mailboxId, list);
	}

	const byIdentity = new Map<
		string,
		{ identity: typeof identities.$inferSelect; mailboxes: MailboxOverview[] }
	>();
	for (const row of rows) {
		const entry = byIdentity.get(row.identity.id) ?? {
			identity: row.identity,
			mailboxes: [],
		};
		if (row.mailbox) {
			const agg = aggByMailbox.get(row.mailbox.id);
			entry.mailboxes.push({
				...row.mailbox,
				unreadCount: Number(agg?.unreadTotal ?? 0),
				unreadThreads: Number(agg?.unreadThreads ?? 0),
				totalThreads: Number(agg?.totalThreads ?? 0),
				recentThreads: recentByMailbox.get(row.mailbox.id) ?? [],
			});
		}
		byIdentity.set(row.identity.id, entry);
	}

	return apiSuccess(Array.from(byIdentity.values()));
});
