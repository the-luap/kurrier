import { db, messageAttachments, messages, threads } from "@db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { defineEventHandler, getQuery, getRouterParam } from "h3";
import {
	apiError,
	apiSuccess,
	validateApiKey,
} from "../../../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);
	const id = getRouterParam(event, "id");
	if (!id) return apiError(400, "INVALID_THREAD_ID", "Thread id is required");

	const [thread] = await db
		.select()
		.from(threads)
		.where(and(eq(threads.id, id), eq(threads.ownerId, ownerId)))
		.limit(1);
	if (!thread) return apiError(404, "THREAD_NOT_FOUND", "Thread not found");

	const query = getQuery(event);
	const includeHtml = query.includeHtml === "true";
	const requestedLimit = Number(query.limit ?? 50);
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(requestedLimit, 1), 100)
		: 50;

	const messageRows = await db
		.select()
		.from(messages)
		.where(and(eq(messages.ownerId, ownerId), eq(messages.threadId, id)))
		.orderBy(asc(messages.date), asc(messages.createdAt))
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
		thread,
		messages: messageRows.map((message) => ({
			...message,
			html: includeHtml ? message.html : undefined,
			attachments: attachmentsByMessage.get(message.id) ?? [],
		})),
	});
});
