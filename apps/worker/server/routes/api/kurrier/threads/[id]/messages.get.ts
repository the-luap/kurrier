import { db, messages, threads } from "@db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { defineEventHandler, getQuery, getRouterParam } from "h3";
import {
	API_SCOPES,
	apiError,
	apiSuccess,
	resolveApiActor,
	UUID_RE,
} from "../../../../../../lib/api-helpers";
import {
	accessibleMailboxIdsQuery,
	paginate,
	messageColumns,
	readBodyOptions,
	readPagination,
	serializeMessagesWithAttachments,
} from "../../../../../../lib/api/mail-access";

// GET /api/kurrier/threads/:id/messages[?limit=&offset=&includeHtml=&includeText=]
// Messages of a thread in chronological order, limited to the mailboxes
// the key's user can read.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);
	const bodyOptions = readBodyOptions(event);
	const id = getRouterParam(event, "id");
	if (!id || !UUID_RE.test(id)) {
		return apiError(400, "INVALID_THREAD_ID", "A thread uuid is required");
	}

	const [thread] = await db
		.select({
			id: threads.id,
			messageCount: threads.messageCount,
			lastMessageDate: threads.lastMessageDate,
			createdAt: threads.createdAt,
		})
		.from(threads)
		.where(and(eq(threads.id, id), eq(threads.workspaceId, actor.workspaceId)))
		.limit(1);
	if (!thread) return apiError(404, "THREAD_NOT_FOUND", "Thread not found");

	const page = readPagination(event);
	const rows = await db
		.select(messageColumns(bodyOptions))
		.from(messages)
		.where(
			and(
				eq(messages.workspaceId, actor.workspaceId),
				eq(messages.threadId, thread.id),
				inArray(messages.mailboxId, accessibleMailboxIdsQuery(actor)),
			),
		)
		.orderBy(asc(messages.date), asc(messages.createdAt), asc(messages.id))
		.limit(page.limit + 1)
		.offset(page.offset);

	if (!rows.length && page.offset === 0) {
		return apiError(404, "THREAD_NOT_FOUND", "Thread not found");
	}

	const { items, pagination } = paginate(rows, page);
	return apiSuccess({
		thread,
		messages: await serializeMessagesWithAttachments(actor, items, bodyOptions),
		pagination,
	});
});
