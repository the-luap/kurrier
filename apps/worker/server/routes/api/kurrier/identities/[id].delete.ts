import { db, identities } from "@db";
import { and, eq } from "drizzle-orm";
import { defineEventHandler, getRouterParam } from "h3";
import {
	apiError,
	apiSuccess,
	validateApiKey,
} from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, [
		"emails:send",
		"emails:receive",
	]);
	const id = getRouterParam(event, "id");

	if (!id) {
		return apiError(400, "INVALID_IDENTITY_ID", "Identity id is required");
	}

	const [existing] = await db
		.select()
		.from(identities)
		.where(and(eq(identities.id, String(id)), eq(identities.ownerId, ownerId)));

	if (!existing) {
		return apiError(404, "IDENTITY_NOT_FOUND", "Identity not found");
	}

	if (existing.ownerId !== ownerId) {
		return apiError(403, "FORBIDDEN", "You do not own this identity");
	}

	await db
		.delete(identities)
		.where(and(eq(identities.id, String(id)), eq(identities.ownerId, ownerId)));

	return apiSuccess({
		id: existing.id,
		deleted: true,
	});
});
