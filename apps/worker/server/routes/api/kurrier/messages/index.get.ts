import { db, messageAttachments, messages } from "@db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { defineEventHandler, getQuery } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);
	const query = getQuery(event);
	const includeHtml = query.includeHtml === "true";
	const requestedLimit = Number(query.limit ?? 50);
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(requestedLimit, 1), 100)
		: 50;
	const mailboxId =
		typeof query.mailboxId === "string" ? query.mailboxId : null;
	const threadId = typeof query.threadId === "string" ? query.threadId : null;

	const conditions = [eq(messages.ownerId, ownerId)];
	if (mailboxId) conditions.push(eq(messages.mailboxId, mailboxId));
	if (threadId) conditions.push(eq(messages.threadId, threadId));

	const messageRows = await db
		.select()
		.from(messages)
		.where(and(...conditions))
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
		messages: messageRows.map((message) => ({
			...message,
			html: includeHtml ? message.html : undefined,
			attachments: attachmentsByMessage.get(message.id) ?? [],
		})),
	});
});
