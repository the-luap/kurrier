import { db, mailboxThreads } from "@db";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { defineEventHandler, getQuery } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	resolveApiActor,
} from "../../../../../lib/api-helpers";
import { listMailboxesByIdentity } from "../../../../../lib/api/mail-access";

const RECENT_PER_INBOX = 3;

// GET /api/kurrier/mailboxes/overview
// Like /mailboxes, plus unread/total thread counts per mailbox and up to
// three recent unread (not snoozed) threads per inbox.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);

	const entries = await listMailboxesByIdentity(actor);
	const mailboxIds = entries.flatMap((e) => e.mailboxes.map((m) => m.id));
	const inboxIds = entries.flatMap((e) =>
		e.mailboxes.filter((m) => m.kind === "inbox").map((m) => m.id),
	);

	const counts = mailboxIds.length
		? await db
				.select({
					mailboxId: mailboxThreads.mailboxId,
					unreadThreads: sql<number>`count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)`,
					unreadCount: sql<number>`coalesce(sum(${mailboxThreads.unreadCount}), 0)`,
					totalThreads: sql<number>`count(*)`,
				})
				.from(mailboxThreads)
				.where(
					and(
						eq(mailboxThreads.workspaceId, actor.workspaceId),
						inArray(mailboxThreads.mailboxId, mailboxIds),
					),
				)
				.groupBy(mailboxThreads.mailboxId)
		: [];

	const now = new Date();
	const recentRows = inboxIds.length
		? await db
				.select({
					threadId: mailboxThreads.threadId,
					mailboxId: mailboxThreads.mailboxId,
					subject: mailboxThreads.subject,
					previewText: mailboxThreads.previewText,
					participants: mailboxThreads.participants,
					lastActivityAt: mailboxThreads.lastActivityAt,
					unreadCount: mailboxThreads.unreadCount,
					messageCount: mailboxThreads.messageCount,
				})
				.from(mailboxThreads)
				.where(
					and(
						eq(mailboxThreads.workspaceId, actor.workspaceId),
						inArray(mailboxThreads.mailboxId, inboxIds),
						gt(mailboxThreads.unreadCount, 0),
						or(
							isNull(mailboxThreads.snoozedUntil),
							lte(mailboxThreads.snoozedUntil, now),
						),
					),
				)
				.orderBy(desc(mailboxThreads.lastActivityAt))
				.limit(Math.min(inboxIds.length * RECENT_PER_INBOX * 5, 500))
		: [];

	const countsByMailbox = new Map(counts.map((c) => [c.mailboxId, c]));
	const recentByMailbox = new Map<string, typeof recentRows>();
	for (const thread of recentRows) {
		const list = recentByMailbox.get(thread.mailboxId) ?? [];
		if (list.length < RECENT_PER_INBOX) list.push(thread);
		recentByMailbox.set(thread.mailboxId, list);
	}

	return apiSuccess(
		entries.map((entry) => ({
			identity: entry.identity,
			mailboxes: entry.mailboxes.map((mailbox) => {
				const c = countsByMailbox.get(mailbox.id);
				return {
					...mailbox,
					unreadCount: Number(c?.unreadCount ?? 0),
					unreadThreads: Number(c?.unreadThreads ?? 0),
					totalThreads: Number(c?.totalThreads ?? 0),
					recentThreads: recentByMailbox.get(mailbox.id) ?? [],
				};
			}),
		})),
	);
});
