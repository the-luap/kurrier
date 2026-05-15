import { db, webhooks } from "@db";
import { and, eq } from "drizzle-orm";
import { defineEventHandler, getRouterParam } from "h3";
import {
	apiError,
	apiSuccess,
	validateApiKey,
} from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);
	const id = getRouterParam(event, "id");

	if (!id) {
		return apiError(400, "INVALID_WEBHOOK_ID", "Webhook id is required");
	}

	const [existing] = await db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.id, String(id)), eq(webhooks.ownerId, ownerId)));

	if (!existing) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}

	if (existing.ownerId !== ownerId) {
		return apiError(403, "FORBIDDEN", "You do not own this webhook");
	}

	await db
		.delete(webhooks)
		.where(and(eq(webhooks.id, String(id)), eq(webhooks.ownerId, ownerId)));

	return apiSuccess({
		id: existing.id,
		deleted: true,
	});
});
