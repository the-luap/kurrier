import { db, mailboxThreads } from "@db";
import { and, desc, eq, gt } from "drizzle-orm";
import { defineEventHandler, getQuery, getRouterParam } from "h3";
import {
	API_SCOPES,
	apiError,
	apiSuccess,
	resolveApiActor,
} from "../../../../../../lib/api-helpers";
import {
	findAccessibleMailbox,
	paginate,
	readPagination,
	serializeMailbox,
} from "../../../../../../lib/api/mail-access";

// GET /api/kurrier/mailboxes/:id/threads[?limit=&offset=&unread=true]
// Threads of a mailbox, newest activity first.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);
	const id = getRouterParam(event, "id");
	if (!id) return apiError(400, "INVALID_MAILBOX_ID", "Mailbox id is required");

	const found = await findAccessibleMailbox(actor, id);
	if (!found) return apiError(404, "MAILBOX_NOT_FOUND", "Mailbox not found");

	const page = readPagination(event);
	const unreadOnly = String(query.unread ?? "") === "true";

	const rows = await db
		.select({
			threadId: mailboxThreads.threadId,
			mailboxId: mailboxThreads.mailboxId,
			identityId: mailboxThreads.identityId,
			subject: mailboxThreads.subject,
			previewText: mailboxThreads.previewText,
			participants: mailboxThreads.participants,
			lastActivityAt: mailboxThreads.lastActivityAt,
			firstMessageAt: mailboxThreads.firstMessageAt,
			messageCount: mailboxThreads.messageCount,
			unreadCount: mailboxThreads.unreadCount,
			hasAttachments: mailboxThreads.hasAttachments,
			starred: mailboxThreads.starred,
			snoozedUntil: mailboxThreads.snoozedUntil,
		})
		.from(mailboxThreads)
		.where(
			and(
				eq(mailboxThreads.workspaceId, actor.workspaceId),
				eq(mailboxThreads.mailboxId, found.mailbox.id),
				unreadOnly ? gt(mailboxThreads.unreadCount, 0) : undefined,
			),
		)
		.orderBy(desc(mailboxThreads.lastActivityAt), desc(mailboxThreads.threadId))
		.limit(page.limit + 1)
		.offset(page.offset);

	const { items, pagination } = paginate(rows, page);
	return apiSuccess({
		mailbox: serializeMailbox(found.mailbox),
		threads: items,
		pagination,
	});
});
