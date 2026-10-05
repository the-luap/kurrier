import { defineEventHandler } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	validateApiKey,
} from "../../../../../lib/api-helpers";
import { db, identities } from "@db";
import { and, eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
	const { ownerId, apiKey } = await validateApiKey(event, API_SCOPES.manage);
	const identitiesList = await db
		.select()
		.from(identities)
		.where(
			and(
				eq(identities.ownerId, ownerId),
				eq(identities.workspaceId, apiKey.workspaceId),
			),
		);
	return apiSuccess(identitiesList);
});
