import { db, messages } from "@db";
import { and, eq, inArray } from "drizzle-orm";
import { defineEventHandler, getQuery, getRouterParam } from "h3";
import {
	API_SCOPES,
	apiError,
	apiSuccess,
	resolveApiActor,
} from "../../../../../lib/api-helpers";
import {
	accessibleMailboxIdsQuery,
	idOrPublicId,
	messageColumns,
	readBodyOptions,
	serializeMessagesWithAttachments,
} from "../../../../../lib/api/mail-access";

// GET /api/kurrier/messages/:id (alias: /api/kurrier/emails/:id)
// One message by uuid or publicId. html and text are included by default
// (includeHtml=false / includeText=false to skip); headers on request.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);
	const bodyOptions = readBodyOptions(event, {
		includeHtml: true,
		includeText: true,
	});
	const id = getRouterParam(event, "id");
	if (!id) return apiError(400, "INVALID_MESSAGE_ID", "Message id is required");

	const [message] = await db
		.select(messageColumns(bodyOptions))
		.from(messages)
		.where(
			and(
				idOrPublicId(messages.id, messages.publicId, id),
				eq(messages.workspaceId, actor.workspaceId),
				inArray(messages.mailboxId, accessibleMailboxIdsQuery(actor)),
			),
		)
		.limit(1);
	if (!message) return apiError(404, "MESSAGE_NOT_FOUND", "Message not found");

	const [serialized] = await serializeMessagesWithAttachments(
		actor,
		[message],
		bodyOptions,
	);
	return apiSuccess(serialized);
});
