import { db, mailboxes, messageAttachments, messages } from "@db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { defineEventHandler, getQuery, getRouterParam } from "h3";
import {
	apiError,
	apiSuccess,
	validateApiKey,
} from "../../../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);
	const id = getRouterParam(event, "id");
	if (!id) return apiError(400, "INVALID_MAILBOX_ID", "Mailbox id is required");

	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.id, id), eq(mailboxes.ownerId, ownerId)))
		.limit(1);
	if (!mailbox) return apiError(404, "MAILBOX_NOT_FOUND", "Mailbox not found");

	const query = getQuery(event);
	const includeHtml = query.includeHtml === "true";
	const requestedLimit = Number(query.limit ?? 50);
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(requestedLimit, 1), 100)
		: 50;

	const messageRows = await db
		.select()
		.from(messages)
		.where(and(eq(messages.ownerId, ownerId), eq(messages.mailboxId, id)))
		.orderBy(desc(messages.date), desc(messages.createdAt))
		.limit(limit);

	const attachmentRows = messageRows.length
		? await db
				.select()
				.from(messageAttachments)
				.where(
					and(
						eq(messageAttachments.ownerId, ownerId),
						inArray(
							messageAttachments.messageId,
							messageRows.map((m) => m.id),
						),
					),
				)
		: [];
	const attachmentsByMessage = new Map<string, typeof attachmentRows>();
	for (const attachment of attachmentRows) {
		const list = attachmentsByMessage.get(attachment.messageId) ?? [];
		list.push(attachment);
		attachmentsByMessage.set(attachment.messageId, list);
	}

	return apiSuccess({
		mailbox,
		messages: messageRows.map((message) => ({
			...message,
			html: includeHtml ? message.html : undefined,
			attachments: attachmentsByMessage.get(message.id) ?? [],
		})),
	});
});
