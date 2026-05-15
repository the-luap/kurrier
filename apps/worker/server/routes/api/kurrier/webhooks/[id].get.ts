import { db, webhooks } from "@db";
import { and, eq } from "drizzle-orm";
import { defineEventHandler, getRouterParam } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);
	const id = getRouterParam(event, "id");
	const [webhook] = await db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.id, String(id)), eq(webhooks.ownerId, ownerId)));
	return apiSuccess(webhook);
});
