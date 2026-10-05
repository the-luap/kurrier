import { defineEventHandler, getQuery, getRouterParam } from "h3";
import {
	API_SCOPES,
	apiError,
	apiSuccess,
	resolveApiActor,
} from "../../../../../../lib/api-helpers";
import { listMailboxesByIdentity } from "../../../../../../lib/api/mail-access";

// GET /api/kurrier/identities/:id/mailboxes
// Mailboxes of one identity (uuid or publicId) of the key's workspace.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);
	const id = getRouterParam(event, "id");
	if (!id) {
		return apiError(400, "INVALID_IDENTITY_ID", "Identity id is required");
	}

	const [entry] = await listMailboxesByIdentity(actor, id);
	if (!entry) {
		return apiError(404, "IDENTITY_NOT_FOUND", "Identity not found");
	}
	return apiSuccess(entry);
});
