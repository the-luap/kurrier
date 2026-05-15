import { db, identities } from "@db";
import { defineEventHandler } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, [
		"emails:send",
		"emails:receive",
	]);
	const identitiesList = await db
		.select()
		.from(identities)
		.where(eq(identities.ownerId, ownerId));
	return apiSuccess(identitiesList);
});
