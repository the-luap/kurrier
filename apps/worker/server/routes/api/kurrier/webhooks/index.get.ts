import { db, webhooks } from "@db";
import { defineEventHandler } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);
	const webhooksList = await db
		.select()
		.from(webhooks)
		.where(eq(webhooks.ownerId, ownerId));
	return apiSuccess(webhooksList);
});
