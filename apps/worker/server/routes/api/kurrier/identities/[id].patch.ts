import { defineEventHandler, getRouterParam, readBody } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	apiError,
	validateApiKey,
	validateIdentityOwnership,
} from "../../../../../lib/api-helpers";
import { db, identities, IdentityCreate, IdentityUpdateSchema } from "@db";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
	const { ownerId, apiKey } = await validateApiKey(event, API_SCOPES.manage);
	const id = getRouterParam(event, "id");
	if (!id) {
		return apiError(400, "INVALID_IDENTITY_ID", "Identity id is required");
	}
	const body = await readBody(event).catch(() => ({}));
	const parsed = IdentityUpdateSchema.safeParse(body);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
			code: issue.code,
		}));
		return apiError(
			400,
			"INVALID_REQUEST_BODY",
			"Invalid request body",
			issues,
		);
	}
	await validateIdentityOwnership({
		identityId: String(id),
		ownerId,
		workspaceId: apiKey.workspaceId,
	});
	// Ownership, workspace and ids are not changeable through the API.
	const {
		id: _id,
		ownerId: _ownerId,
		workspaceId: _workspaceId,
		publicId: _publicId,
		createdAt: _createdAt,
		...changes
	} = parsed.data;
	const [updated] = await db
		.update(identities)
		.set(changes as IdentityCreate)
		.where(eq(identities.id, String(id)))
		.returning();
	return apiSuccess(updated);
});
