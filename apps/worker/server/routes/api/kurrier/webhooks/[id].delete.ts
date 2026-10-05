import { defineEventHandler, getRouterParam } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	apiError,
	validateApiKey,
} from "../../../../../lib/api-helpers";
import { db, webhooks } from "@db";
import { and, eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
	const { ownerId, apiKey } = await validateApiKey(event, API_SCOPES.manage);
	const id = getRouterParam(event, "id");
	if (!id) {
		return apiError(400, "INVALID_WEBHOOK_ID", "Webhook id is required");
	}
	const [existing] = await db
		.select()
		.from(webhooks)
		.where(
			and(
				eq(webhooks.id, String(id)),
				eq(webhooks.ownerId, ownerId),
				eq(webhooks.workspaceId, apiKey.workspaceId),
			),
		)
		.limit(1);
	if (!existing) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}
	await db
		.delete(webhooks)
		.where(
			and(
				eq(webhooks.id, existing.id),
				eq(webhooks.ownerId, ownerId),
				eq(webhooks.workspaceId, apiKey.workspaceId),
			),
		);
	return apiSuccess({
		id: existing.id,
		deleted: true,
	});
});
