import { defineEventHandler } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	validateApiKey,
} from "../../../../../lib/api-helpers";
import { db, webhooks } from "@db";
import { and, eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
	const { ownerId, apiKey } = await validateApiKey(event, API_SCOPES.manage);
	const webhooksList = await db
		.select()
		.from(webhooks)
		.where(
			and(
				eq(webhooks.ownerId, ownerId),
				eq(webhooks.workspaceId, apiKey.workspaceId),
			),
		);
	return apiSuccess(webhooksList);
});
