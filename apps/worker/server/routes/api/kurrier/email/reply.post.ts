import { db, identities, mailboxes, messages } from "@db";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { and, desc, eq } from "drizzle-orm";
import { createError, defineEventHandler } from "h3";
import { extension } from "mime-types";
import { z } from "zod";
import { getServerEnv } from "@schema";
import {
	apiSuccess,
	validateApiKey,
	validateJSONBody,
} from "../../../../../lib/api-helpers";
import { s3 } from "../../../../../lib/create-s3-client";
import { getRedis } from "../../../../../lib/get-redis";

const emailAddress = z.string().trim().email();
const recipientsSchema = z.union([
	emailAddress,
	z.array(emailAddress).nonempty(),
]);
const attachmentSchema = z.object({
	filename: z.string().min(1),
	contentType: z.string().min(1),
	content: z.string().min(1),
});

const EmailReplySchema = z
	.object({
		originalMessageId: z.string().min(1).optional(),
		threadId: z.string().min(1).optional(),
		identityId: z.string().min(1).optional(),
		to: recipientsSchema.optional(),
		cc: recipientsSchema.optional(),
		bcc: recipientsSchema.optional(),
		html: z.string().min(1).optional(),
		text: z.string().min(1).optional(),
		attachments: z.array(attachmentSchema).optional(),
	})
	.refine((data) => !!data.originalMessageId || !!data.threadId, {
		message: "Either 'originalMessageId' or 'threadId' must be provided.",
		path: ["originalMessageId"],
	})
	.refine((data) => !!data.html || !!data.text, {
		message: "Either 'html' or 'text' must be provided.",
		path: ["html"],
	});

function toArray(input: string | string[] | undefined) {
	if (!input) return undefined;
	return Array.isArray(input) ? input : [input];
}

function addressObjectEmails(
	input:
		| { value?: { address?: string | null; name?: string | null }[] }
		| null
		| undefined,
) {
	return (input?.value ?? [])
		.map((item) => item.address?.trim())
		.filter((address): address is string => Boolean(address));
}

function replyToEmails(
	input: { email?: string | null; name?: string | null }[] | null | undefined,
) {
	return (input ?? [])
		.map((item) => item.email?.trim())
		.filter((address): address is string => Boolean(address));
}

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:send"]);
	const { json } = await validateJSONBody(event);
	const parsed = EmailReplySchema.safeParse(json);

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
	const baseWhere = data.originalMessageId
		? eq(messages.id, data.originalMessageId)
		: eq(messages.threadId, String(data.threadId));

	const [original] = await db
		.select({ message: messages, mailbox: mailboxes, identity: identities })
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.innerJoin(identities, eq(mailboxes.identityId, identities.id))
		.where(and(baseWhere, eq(messages.ownerId, ownerId)))
		.orderBy(desc(messages.date), desc(messages.createdAt))
		.limit(1);

	if (!original) {
		throw createError({
			statusCode: 404,
			statusMessage: "Original message not found",
		});
	}

	const identityId = data.identityId ?? original.identity.id;
	const [identity] = await db
		.select()
		.from(identities)
		.where(and(eq(identities.id, identityId), eq(identities.ownerId, ownerId)))
		.limit(1);

	if (!identity) {
		throw createError({
			statusCode: 400,
			statusMessage: "Invalid identityId",
		});
	}

	const [sentMailbox] = await db
		.select()
		.from(mailboxes)
		.where(
			and(
				eq(mailboxes.identityId, identityId),
				eq(mailboxes.ownerId, ownerId),
				eq(mailboxes.slug, "sent"),
			),
		)
		.limit(1);

	if (!sentMailbox) {
		throw createError({
			statusCode: 400,
			statusMessage: "Sent mailbox not found for the given identityId",
		});
	}

	const to = toArray(data.to) ?? [
		...replyToEmails(original.message.replyTo),
		...addressObjectEmails(original.message.from),
	];

	if (!to.length) {
		throw createError({
			statusCode: 400,
			statusMessage: "Could not infer reply recipient; provide 'to' explicitly",
		});
	}

	const newMessageId = crypto.randomUUID();
	const payload = {
		newMessageId,
		messageId: original.message.id,
		originalMessageId: original.message.id,
		messageMailboxId: original.message.mailboxId,
		sentMailboxId: String(sentMailbox.id),
		mailboxId: String(sentMailbox.id),
		mode: "reply",
		identityId,
		to,
		cc: toArray(data.cc),
		bcc: toArray(data.bcc),
		subject: original.message.subject ?? undefined,
		text: data.text,
		html: data.html,
	} as Record<string, unknown>;

	const { S3_BUCKET } = getServerEnv();
	const attachments = [];
	for (const file of data.attachments || []) {
		const ext = extension(file.contentType) || "dat";
		const path = `private/${ownerId}/${newMessageId}/${crypto.randomUUID()}.${ext}`;
		const buffer = Buffer.from(file.content, "base64");

		await s3.send(
			new PutObjectCommand({
				Bucket: S3_BUCKET,
				Key: path,
				Body: buffer,
				ContentType: file.contentType,
			}),
		);

		attachments.push({
			path,
			messageId: newMessageId,
			bucketId: S3_BUCKET,
			filenameOriginal: file.filename,
			contentType: file.contentType,
			sizeBytes: buffer.length,
		});
	}

	payload.attachments = JSON.stringify(attachments);
	const { sendMailQueue } = await getRedis();
	await sendMailQueue.add("send-and-reconcile", payload);

	return apiSuccess({
		messageId: newMessageId,
		originalMessageId: original.message.id,
	});
});
