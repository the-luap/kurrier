import { defineEventHandler, getRouterParam } from "h3";
import {
	API_SCOPES,
	apiError,
	apiSuccess,
	validateApiKey,
} from "../../../../../lib/api-helpers";
import { db, webhooks } from "@db";
import { and, eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
	const { ownerId, apiKey } = await validateApiKey(event, API_SCOPES.manage);
	const id = getRouterParam(event, "id");
	const [webhook] = await db
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
	if (!webhook) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}
	return apiSuccess(webhook);
});
