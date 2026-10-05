import { db, messages } from "@db";
import { and, desc, eq } from "drizzle-orm";
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
	messageColumns,
	readBodyOptions,
	readPagination,
	serializeMailbox,
	serializeMessagesWithAttachments,
} from "../../../../../../lib/api/mail-access";

// GET /api/kurrier/mailboxes/:id/messages[?limit=&offset=&includeHtml=&includeText=]
// Messages of a mailbox, newest first. Bodies only on request.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);
	const bodyOptions = readBodyOptions(event);
	const id = getRouterParam(event, "id");
	if (!id) return apiError(400, "INVALID_MAILBOX_ID", "Mailbox id is required");

	const found = await findAccessibleMailbox(actor, id);
	if (!found) return apiError(404, "MAILBOX_NOT_FOUND", "Mailbox not found");

	const page = readPagination(event);
	const rows = await db
		.select(messageColumns(bodyOptions))
		.from(messages)
		.where(
			and(
				eq(messages.workspaceId, actor.workspaceId),
				eq(messages.mailboxId, found.mailbox.id),
			),
		)
		.orderBy(desc(messages.date), desc(messages.createdAt), desc(messages.id))
		.limit(page.limit + 1)
		.offset(page.offset);

	const { items, pagination } = paginate(rows, page);
	return apiSuccess({
		mailbox: serializeMailbox(found.mailbox),
		messages: await serializeMessagesWithAttachments(actor, items, bodyOptions),
		pagination,
	});
});
