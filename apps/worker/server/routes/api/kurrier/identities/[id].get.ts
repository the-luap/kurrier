import { db, identities } from "@db";
import { and, eq } from "drizzle-orm";
import { defineEventHandler, getRouterParam } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, [
		"emails:send",
		"emails:receive",
	]);
	const id = getRouterParam(event, "id");
	const [identity] = await db
		.select()
		.from(identities)
		.where(and(eq(identities.id, String(id)), eq(identities.ownerId, ownerId)));
	return apiSuccess(identity);
});
