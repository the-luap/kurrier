import { defineEventHandler, getRouterParam } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	validateApiKey,
	validateIdentityOwnership,
} from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId, apiKey } = await validateApiKey(event, API_SCOPES.manage);
	const id = getRouterParam(event, "id");
	const identity = await validateIdentityOwnership({
		identityId: String(id),
		ownerId,
		workspaceId: apiKey.workspaceId,
	});
	return apiSuccess(identity);
});
