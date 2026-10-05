import { defineEventHandler, getQuery } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	resolveApiActor,
} from "../../../../../lib/api-helpers";
import { listMailboxesByIdentity } from "../../../../../lib/api/mail-access";

// GET /api/kurrier/mailboxes[?identityId=]
// Email identities of the key's workspace the key's user can read, each
// with its mailboxes.
export default defineEventHandler(async (event) => {
	const query = getQuery(event);
	const actor = await resolveApiActor(
		event,
		query.userEmail ? String(query.userEmail) : undefined,
		API_SCOPES.read,
	);
	const identityId =
		typeof query.identityId === "string" && query.identityId
			? query.identityId
			: undefined;

	return apiSuccess(await listMailboxesByIdentity(actor, identityId));
});
