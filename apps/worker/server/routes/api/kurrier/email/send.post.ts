import { EmailSendSchema } from "@schema";
import { createError, defineEventHandler, getQuery } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	resolveApiActor,
	validateJSONBody,
} from "../../../../../lib/api-helpers";
import {
	enqueueSend,
	findSendableIdentity,
	findSentMailbox,
	uploadApiAttachments,
} from "../../../../../lib/api/send";

// POST /api/kurrier/email/send (alias: /api/kurrier/email/compose)
// Sends a new message from an identity of the API key's workspace through
// the regular send-mail worker.
export default defineEventHandler(async (event) => {
	const { json } = await validateJSONBody(event);
	const userEmail = json?.userEmail ?? getQuery(event).userEmail;
	const actor = await resolveApiActor(
		event,
		userEmail ? String(userEmail) : undefined,
		API_SCOPES.send,
	);

	const parsed = EmailSendSchema.safeParse(json);

	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
			code: issue.code,
		}));

		throw createError({
			statusCode: 400,
			statusMessage: "Invalid request body",
			data: { issues },
		});
	}

	const data = parsed.data;
	const identity = await findSendableIdentity(actor, data.identityId);
	if (!identity) {
		throw createError({
			statusCode: 403,
			statusMessage: "Identity not found or access denied",
		});
	}

	const sentMailbox = await findSentMailbox(identity.id, identity.workspaceId);
	const newMessageId = crypto.randomUUID();

	const attachments = await uploadApiAttachments({
		uploaderId: actor.ownerId,
		messageId: newMessageId,
		attachments: data.attachments,
	});

	await enqueueSend({
		identityId: identity.id,
		to: data.to,
		cc: data.cc,
		bcc: data.bcc,
		subject: data.subject,
		text: data.text,
		html: data.html,
		newMessageId,
		apiMessageId: newMessageId,
		messageMailboxId: "",
		sentMailboxId: String(sentMailbox.id),
		mailboxId: String(sentMailbox.id),
		mode: "compose",
		attachments,
	});

	return apiSuccess({ messageId: newMessageId, status: "queued" });
});
