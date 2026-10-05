import { db, identities, mailboxes, messages } from "@db";
import { and, desc, eq } from "drizzle-orm";
import { createError, defineEventHandler, getQuery } from "h3";
import {
	API_SCOPES,
	apiSuccess,
	resolveApiActor,
	UUID_RE,
	validateJSONBody,
} from "../../../../../lib/api-helpers";
import {
	accessibleIdentityCondition,
	idOrPublicId,
} from "../../../../../lib/api/mail-access";
import {
	type ApiAttachmentInput,
	enqueueSend,
	findSendableIdentity,
	findSentMailbox,
	uploadApiAttachments,
} from "../../../../../lib/api/send";

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

type Issue = { path: string; message: string; code: string };

function readRecipients(
	value: unknown,
	path: string,
	issues: Issue[],
): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const list = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	for (const entry of list) {
		const address = typeof entry === "string" ? entry.trim() : "";
		if (!EMAIL_RE.test(address)) {
			issues.push({
				path,
				message: "Invalid email address",
				code: "invalid_string",
			});
			continue;
		}
		out.push(address);
	}
	if (!out.length && !issues.length) {
		issues.push({ path, message: "At least one recipient", code: "too_small" });
	}
	return out;
}

function optionalString(value: unknown, path: string, issues: Issue[]) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !value.length) {
		issues.push({
			path,
			message: "Expected a non-empty string",
			code: "invalid_type",
		});
		return undefined;
	}
	return value;
}

function readAttachments(value: unknown, issues: Issue[]) {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) {
		issues.push({
			path: "attachments",
			message: "Expected an array",
			code: "invalid_type",
		});
		return undefined;
	}
	const out: ApiAttachmentInput[] = [];
	value.forEach((item, index) => {
		if (
			!item ||
			typeof item.filename !== "string" ||
			typeof item.contentType !== "string" ||
			typeof item.content !== "string" ||
			!item.filename ||
			!item.contentType ||
			!item.content
		) {
			issues.push({
				path: `attachments.${index}`,
				message: "filename, contentType and content (base64) are required",
				code: "invalid_type",
			});
			return;
		}
		out.push({
			filename: item.filename,
			contentType: item.contentType,
			content: item.content,
		});
	});
	return out;
}

function parseReplyBody(json: unknown) {
	const issues: Issue[] = [];
	const body = (json && typeof json === "object" ? json : {}) as Record<
		string,
		unknown
	>;

	const data = {
		originalMessageId: optionalString(
			body.originalMessageId ?? body.messageId,
			"originalMessageId",
			issues,
		),
		threadId: optionalString(body.threadId, "threadId", issues),
		identityId: optionalString(body.identityId, "identityId", issues),
		subject: optionalString(body.subject, "subject", issues),
		html: optionalString(body.html, "html", issues),
		text: optionalString(body.text, "text", issues),
		to: readRecipients(body.to, "to", issues),
		cc: readRecipients(body.cc, "cc", issues),
		bcc: readRecipients(body.bcc, "bcc", issues),
		attachments: readAttachments(body.attachments, issues),
	};

	if (!data.originalMessageId && !data.threadId) {
		issues.push({
			path: "originalMessageId",
			message: "Either 'originalMessageId' or 'threadId' must be provided.",
			code: "custom",
		});
	}
	if (!data.html && !data.text) {
		issues.push({
			path: "html",
			message: "Either 'html' or 'text' must be provided.",
			code: "custom",
		});
	}
	if (data.threadId && !UUID_RE.test(data.threadId)) {
		issues.push({
			path: "threadId",
			message: "Invalid thread id",
			code: "invalid_string",
		});
	}

	return { data, issues };
}

function addressObjectEmails(
	input: { value?: { address?: string | null }[] } | null | undefined,
) {
	return (input?.value ?? [])
		.map((item) => item.address?.trim())
		.filter((address): address is string => Boolean(address));
}

function replyToEmails(input: { email?: string | null }[] | null | undefined) {
	return (input ?? [])
		.map((item) => item.email?.trim())
		.filter((address): address is string => Boolean(address));
}

// POST /api/kurrier/email/reply
// Replies to a message (or the latest message of a thread) the API key's
// workspace can read. The send-mail worker adds In-Reply-To/References,
// the "Re:" subject and the quoted original, and files the reply into the
// original thread.
export default defineEventHandler(async (event) => {
	const { json } = await validateJSONBody(event);
	const userEmail = json?.userEmail ?? getQuery(event).userEmail;
	const actor = await resolveApiActor(
		event,
		userEmail ? String(userEmail) : undefined,
		API_SCOPES.send,
	);

	const { data, issues } = parseReplyBody(json);
	if (issues.length) {
		throw createError({
			statusCode: 400,
			statusMessage: "Invalid request body",
			data: { issues },
		});
	}

	const target = data.originalMessageId
		? idOrPublicId(messages.id, messages.publicId, data.originalMessageId)
		: eq(messages.threadId, String(data.threadId));

	// The original must live in a mailbox of an identity the key can read.
	const [original] = await db
		.select({ message: messages, mailbox: mailboxes, identity: identities })
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.innerJoin(identities, eq(mailboxes.identityId, identities.id))
		.where(
			and(
				target,
				eq(messages.workspaceId, actor.workspaceId),
				accessibleIdentityCondition(actor),
			),
		)
		.orderBy(desc(messages.date), desc(messages.createdAt))
		.limit(1);

	if (!original) {
		throw createError({
			statusCode: 404,
			statusMessage: "Original message not found",
		});
	}

	const identity = await findSendableIdentity(
		actor,
		data.identityId ?? original.identity.id,
	);
	if (!identity) {
		throw createError({
			statusCode: 403,
			statusMessage: "Identity not found or access denied",
		});
	}

	const sentMailbox = await findSentMailbox(identity.id, identity.workspaceId);

	const to = data.to ?? [
		...new Set([
			...replyToEmails(original.message.replyTo),
			...(original.message.replyTo?.length
				? []
				: addressObjectEmails(original.message.from)),
		]),
	];

	if (!to.length) {
		throw createError({
			statusCode: 400,
			statusMessage: "Could not infer reply recipient; provide 'to' explicitly",
		});
	}

	const newMessageId = crypto.randomUUID();
	const attachments = await uploadApiAttachments({
		uploaderId: actor.ownerId,
		messageId: newMessageId,
		attachments: data.attachments,
	});

	await enqueueSend({
		identityId: identity.id,
		newMessageId,
		apiMessageId: newMessageId,
		messageId: original.message.id,
		originalMessageId: original.message.id,
		messageMailboxId: original.message.mailboxId,
		sentMailboxId: String(sentMailbox.id),
		mailboxId: String(sentMailbox.id),
		mode: "reply",
		to,
		cc: data.cc,
		bcc: data.bcc,
		// Empty subject: the worker derives "Re: <original subject>".
		subject: data.subject,
		text: data.text,
		html: data.html,
		attachments,
	});

	return apiSuccess({
		messageId: newMessageId,
		originalMessageId: original.message.id,
		threadId: original.message.threadId,
		status: "queued",
	});
});
