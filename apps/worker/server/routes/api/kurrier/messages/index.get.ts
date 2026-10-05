import { db, messages } from "@db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { defineEventHandler, getQuery } from "h3";
import {
	API_SCOPES,
	apiError,
	apiSuccess,
	resolveApiActor,
	UUID_RE,
} from "../../../../../lib/api-helpers";
import {
	accessibleMailboxIdsQuery,
	findAccessibleMailbox,
	paginate,
	messageColumns,
	readBodyOptions,
	readPagination,
	serializeMessagesWithAttachments,
} from "../../../../../lib/api/mail-access";

// GET /api/kurrier/messages (alias: /api/kurrier/emails)
//   [?mailboxId=&threadId=&unread=true&limit=&offset=&includeHtml=&includeText=]
// Messages across all mailboxes the key's user can read, newest first.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);
	const bodyOptions = readBodyOptions(event);

	const mailboxParam =
		typeof query.mailboxId === "string" && query.mailboxId
			? query.mailboxId
			: null;
	const threadId =
		typeof query.threadId === "string" && query.threadId
			? query.threadId
			: null;
	if (threadId && !UUID_RE.test(threadId)) {
		return apiError(400, "INVALID_THREAD_ID", "threadId must be a uuid");
	}

	let mailboxId: string | null = null;
	if (mailboxParam) {
		const found = await findAccessibleMailbox(actor, mailboxParam);
		if (!found) return apiError(404, "MAILBOX_NOT_FOUND", "Mailbox not found");
		mailboxId = found.mailbox.id;
	}

	const page = readPagination(event);
	const rows = await db
		.select(messageColumns(bodyOptions))
		.from(messages)
		.where(
			and(
				eq(messages.workspaceId, actor.workspaceId),
				mailboxId
					? eq(messages.mailboxId, mailboxId)
					: inArray(messages.mailboxId, accessibleMailboxIdsQuery(actor)),
				threadId ? eq(messages.threadId, threadId) : undefined,
				String(query.unread ?? "") === "true"
					? eq(messages.seen, false)
					: undefined,
			),
		)
		.orderBy(
			sql`${messages.date} desc nulls last`,
			desc(messages.createdAt),
			desc(messages.id),
		)
		.limit(page.limit + 1)
		.offset(page.offset);

	const { items, pagination } = paginate(rows, page);
	return apiSuccess({
		messages: await serializeMessagesWithAttachments(actor, items, bodyOptions),
		pagination,
	});
});
