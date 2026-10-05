import { PutObjectCommand } from "@aws-sdk/client-s3";
import { db, identities, mailboxes } from "@db";
import { getServerEnv } from "@schema";
import { and, desc, eq, or } from "drizzle-orm";
import { createError } from "h3";
import { extension } from "mime-types";
import { type ApiActor, UUID_RE } from "../api-helpers";
import { s3 } from "../create-s3-client";
import { getRedis } from "../get-redis";
import { accessibleIdentityCondition } from "./mail-access";

export type ApiAttachmentInput = {
	filename: string;
	contentType: string;
	/** base64 encoded file content */
	content: string;
};

/** Upper bound for the decoded size of all attachments of one API send. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Identity the actor may send from: in the key's workspace and owned by,
 * shared with, or assigned to the key's user. Domain identities cannot send.
 */
export async function findSendableIdentity(
	actor: ApiActor,
	identityId: string,
) {
	if (!UUID_RE.test(identityId)) return null;
	const [identity] = await db
		.select()
		.from(identities)
		.where(
			and(
				eq(identities.id, identityId),
				eq(identities.kind, "email"),
				accessibleIdentityCondition(actor),
			),
		)
		.limit(1);
	return identity ?? null;
}

export async function findSentMailbox(identityId: string, workspaceId: string) {
	const [sentMailbox] = await db
		.select()
		.from(mailboxes)
		.where(
			and(
				eq(mailboxes.identityId, identityId),
				eq(mailboxes.workspaceId, workspaceId),
				or(eq(mailboxes.slug, "sent"), eq(mailboxes.kind, "sent")),
			),
		)
		.orderBy(desc(mailboxes.isDefault))
		.limit(1);

	if (!sentMailbox) {
		throw createError({
			statusCode: 400,
			statusMessage: "Sent mailbox not found for the given identityId",
		});
	}
	return sentMailbox;
}

/**
 * Uploads base64 API attachments to the upload folder the send pipeline
 * accepts (`private/<identity owner>/<message id>/...`) and returns the
 * JSON string the `send-and-reconcile` job expects.
 */
export async function uploadApiAttachments(opts: {
	uploaderId: string;
	messageId: string;
	attachments: ApiAttachmentInput[] | undefined;
}) {
	const files = opts.attachments ?? [];
	if (!files.length) return JSON.stringify([]);

	const buffers = files.map((file) => Buffer.from(file.content, "base64"));
	const total = buffers.reduce((sum, b) => sum + b.length, 0);
	if (total > MAX_ATTACHMENT_BYTES) {
		throw createError({
			statusCode: 413,
			statusMessage: "Attachments exceed the 25 MB limit",
		});
	}

	const { S3_BUCKET } = getServerEnv();
	const uploaded = [];

	for (const [index, file] of files.entries()) {
		const buffer = buffers[index];
		const ext = extension(file.contentType) || "dat";
		const path = `private/${opts.uploaderId}/${opts.messageId}/${crypto.randomUUID()}.${ext}`;

		await s3.send(
			new PutObjectCommand({
				Bucket: S3_BUCKET,
				Key: path,
				Body: buffer,
				ContentType: file.contentType,
			}),
		);

		uploaded.push({
			path,
			messageId: opts.messageId,
			bucketId: S3_BUCKET,
			filenameOriginal: file.filename,
			contentType: file.contentType,
			sizeBytes: buffer.length,
		});
	}

	return JSON.stringify(uploaded);
}

/** Hands a send to the existing send-mail worker (same job as the web UI). */
export async function enqueueSend(payload: Record<string, unknown>) {
	const { sendMailQueue } = await getRedis();
	await sendMailQueue.add("send-and-reconcile", payload);
}
