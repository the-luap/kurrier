import { db, mailboxes, mailboxThreads } from "@db";
import { and, desc, eq } from "drizzle-orm";
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
	const requestedLimit = Number(query.limit ?? 50);
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(requestedLimit, 1), 100)
		: 50;

	const threads = await db
		.select()
		.from(mailboxThreads)
		.where(
			and(
				eq(mailboxThreads.ownerId, ownerId),
				eq(mailboxThreads.mailboxId, id),
			),
		)
		.orderBy(desc(mailboxThreads.lastActivityAt))
		.limit(limit);

	return apiSuccess({ mailbox, threads });
});
