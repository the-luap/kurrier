import { defineEventHandler, getRouterParam, readBody } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	apiError,
	validateApiKey,
	validateIdentityOwnership,
} from "../../../../../lib/api-helpers";
import { validateSmtpAccountOwnership } from "../../../../../lib/smtp-account-helpers";
import { db, identities, IdentityCreate, IdentityUpdateSchema } from "@db";
import { eq } from "drizzle-orm";

/**
 * Fields an API key may change. Everything else (value, kind, status,
 * providerId, domainIdentityId, dnsRecords, sharing, ids, ...) drives
 * verification, inbound routing or access control and is managed by the
 * dashboard only: e.g. changing `value` or `status` would let a key claim
 * an unverified address, `providerId` would point at another provider.
 */
const UPDATABLE_FIELDS = new Set(["displayName", "smtpAccountId", "metaData"]);

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
	const existing = await validateIdentityOwnership({
		identityId: String(id),
		ownerId,
		workspaceId: apiKey.workspaceId,
	});

	const rejected = Object.keys(parsed.data).filter(
		(key) =>
			!UPDATABLE_FIELDS.has(key) &&
			(parsed.data as Record<string, unknown>)[key] !== undefined,
	);
	if (rejected.length) {
		return apiError(
			400,
			"FIELD_NOT_UPDATABLE",
			`These fields cannot be changed through the API: ${rejected.join(", ")}`,
			rejected.map((path) => ({
				path,
				message: "Not updatable through the API",
				code: "not_updatable",
			})),
		);
	}

	const changes: Partial<IdentityCreate> = {};
	if (parsed.data.displayName !== undefined) {
		changes.displayName = parsed.data.displayName;
	}
	if (parsed.data.smtpAccountId !== undefined) {
		if (parsed.data.smtpAccountId !== null) {
			// The SMTP account must belong to the key's user and workspace.
			await validateSmtpAccountOwnership({
				accountId: String(parsed.data.smtpAccountId),
				ownerId,
				workspaceId: apiKey.workspaceId,
			});
		}
		changes.smtpAccountId = parsed.data.smtpAccountId;
	}
	if (parsed.data.metaData !== undefined) {
		// Only the sending quota is caller controlled: other meta keys carry
		// provider wiring (e.g. gmail.googleAccountId) and must not change.
		const meta = (parsed.data.metaData ?? {}) as Record<string, unknown>;
		const extraKeys = Object.keys(meta).filter((k) => k !== "dailyQuota");
		const quota = meta.dailyQuota;
		if (
			extraKeys.length ||
			(quota !== undefined &&
				!(typeof quota === "number" && Number.isInteger(quota) && quota > 0))
		) {
			return apiError(
				400,
				"FIELD_NOT_UPDATABLE",
				"Only metaData.dailyQuota (positive integer) can be changed through the API",
			);
		}
		if (quota !== undefined) {
			changes.metaData = {
				...((existing.metaData as Record<string, unknown> | null) ?? {}),
				dailyQuota: quota,
			};
		}
	}

	if (Object.keys(changes).length === 0) {
		return apiSuccess(existing);
	}

	const [updated] = await db
		.update(identities)
		.set({ ...changes, updatedAt: new Date() })
		.where(eq(identities.id, existing.id))
		.returning();
	return apiSuccess(updated);
});
