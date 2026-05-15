import {
	db,
	type WebhookInsertEntity,
	WebhookUpdateSchema,
	webhooks,
} from "@db";
import { and, eq } from "drizzle-orm";
import { defineEventHandler, getRouterParam, readBody } from "h3";
import {
	apiError,
	apiSuccess,
	validateApiKey,
} from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);
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

	const updates = parsed.data;

	const [existing] = await db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.id, String(id)), eq(webhooks.ownerId, ownerId)));

	if (!existing) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}

	if (existing.ownerId !== ownerId) {
		return apiError(403, "FORBIDDEN", "You do not own this webhook");
	}

	const [updated] = await db
		.update(webhooks)
		.set(updates as WebhookInsertEntity)
		.where(and(eq(webhooks.id, String(id)), eq(webhooks.ownerId, ownerId)))
		.returning();

	return apiSuccess(updated);
});
