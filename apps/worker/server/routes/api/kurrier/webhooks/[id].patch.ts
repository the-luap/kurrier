import { defineEventHandler, getRouterParam, readBody } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	apiError,
	validateApiKey,
	validateIdentityOwnership,
} from "../../../../../lib/api-helpers";
import { db, WebhookInsertEntity, webhooks, WebhookUpdateSchema } from "@db";
import { and, eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
	const { ownerId, apiKey } = await validateApiKey(event, API_SCOPES.manage);
	const id = getRouterParam(event, "id");
	if (!id) {
		return apiError(400, "INVALID_WEBHOOK_ID", "Webhook id is required");
	}
	const body = await readBody(event).catch(() => ({}));
	const parsed = WebhookUpdateSchema.safeParse(body);
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
	const [existing] = await db
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
	if (!existing) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}
	// Ownership, workspace and ids are not changeable through the API.
	const {
		id: _id,
		ownerId: _ownerId,
		workspaceId: _workspaceId,
		createdAt: _createdAt,
		...changes
	} = parsed.data;
	if (changes.identityId) {
		await validateIdentityOwnership({
			identityId: changes.identityId,
			ownerId,
			workspaceId: apiKey.workspaceId,
		});
	}
	const [updated] = await db
		.update(webhooks)
		.set(changes as WebhookInsertEntity)
		.where(
			and(
				eq(webhooks.id, existing.id),
				eq(webhooks.ownerId, ownerId),
				eq(webhooks.workspaceId, apiKey.workspaceId),
			),
		)
		.returning();
	return apiSuccess(updated);
});
