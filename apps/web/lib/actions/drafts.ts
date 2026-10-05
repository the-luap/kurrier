"use server";

import {
	draftMessages,
	identities,
	mailboxes,
	messageAttachments,
	messages,
} from "@db";
import { and, desc, eq, sql } from "drizzle-orm";
import { isSignedIn } from "@/lib/actions/auth";
import { rlsClient } from "@/lib/actions/clients";
import { invalidateServerCache } from "@/lib/server-cache";

/**
 * Autosaved, not yet sent messages are rows of draft_messages with status
 * "draft" (scheduled mail uses status "scheduled" in the same table). The
 * table's RLS is workspace wide, so every query here is additionally limited
 * to the caller's own rows: drafts are private to their author.
 */

export type DraftMode = "compose" | "reply" | "forward";

export type DraftPayload = {
	mode?: DraftMode;
	identityPublicId?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	bodyHtml?: string;
	text?: string;
	/** JSON list of composer attachments (uploads and forwarded originals). */
	attachments?: string;
	signaturePublicId?: string;
	originalMessageId?: string;
	/** Thread page of a reply/forward draft, opened from the drafts list. */
	threadUrl?: string;
};

export type DraftRow = {
	id: string;
	mailboxId: string;
	identityId: string | null;
	payload: DraftPayload;
	createdAt: Date;
	updatedAt: Date;
};

export type ForwardableAttachment = {
	id: string;
	path: string;
	filenameOriginal: string;
	contentType: string;
	sizeBytes: number;
};

const MAX_FIELD_LENGTH = 10_000;
const MAX_BODY_LENGTH = 2 * 1024 * 1024;

const DRAFT_MODES: DraftMode[] = ["compose", "reply", "forward"];

const isUuid = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const field = (value: unknown, max = MAX_FIELD_LENGTH) =>
	typeof value === "string" ? value.slice(0, max) : "";

/** Only known string fields, bounded, so a draft cannot grow without limit. */
function sanitizePayload(payload: DraftPayload): DraftPayload {
	const mode = DRAFT_MODES.includes(payload?.mode as DraftMode)
		? (payload.mode as DraftMode)
		: "compose";
	const originalMessageId = field(payload?.originalMessageId);
	const threadUrl = field(payload?.threadUrl, 2048);
	return {
		mode,
		identityPublicId: field(payload?.identityPublicId),
		to: field(payload?.to),
		cc: field(payload?.cc),
		bcc: field(payload?.bcc),
		subject: field(payload?.subject, 2000),
		bodyHtml: field(payload?.bodyHtml, MAX_BODY_LENGTH),
		text: field(payload?.text, MAX_BODY_LENGTH),
		attachments: field(payload?.attachments, 100_000),
		signaturePublicId: field(payload?.signaturePublicId),
		originalMessageId:
			mode !== "compose" && isUuid(originalMessageId)
				? originalMessageId
				: undefined,
		// Same-origin app paths only (the drafts list navigates to it).
		threadUrl:
			mode !== "compose" && threadUrl.startsWith("/") && !threadUrl.startsWith("//")
				? threadUrl
				: undefined,
	};
}

async function currentUserId() {
	const user = await isSignedIn();
	if (!user?.id) throw new Error("Unauthorized");
	return user.id;
}

/**
 * Creates (no draftId) or updates the caller's draft. An update never
 * re-creates a draft that was sent or discarded meanwhile: it returns
 * `draftId: null` instead.
 */
export async function saveDraft(input: {
	draftId?: string | null;
	identityPublicId: string;
	payload: DraftPayload;
}): Promise<{ draftId: string | null; error?: string }> {
	const previousId = input.draftId && isUuid(input.draftId) ? input.draftId : null;
	try {
		const userId = await currentUserId();
		const payload = sanitizePayload({
			...input.payload,
			identityPublicId: input.identityPublicId,
		});
		const rls = await rlsClient();
		const result = await rls(async (tx) => {
			const [identity] = await tx
				.select({ id: identities.id })
				.from(identities)
				.where(eq(identities.publicId, String(input.identityPublicId ?? "")))
				.limit(1);
			if (!identity) return { draftId: previousId, error: "Identity not found" };

			const boxes = await tx
				.select({ id: mailboxes.id, kind: mailboxes.kind })
				.from(mailboxes)
				.where(eq(mailboxes.identityId, identity.id));
			const mailbox =
				boxes.find((box) => box.kind === "inbox") ?? boxes[0] ?? null;
			if (!mailbox) return { draftId: previousId, error: "Mailbox not found" };

			const values = {
				mailboxId: mailbox.id,
				identityId: identity.id,
				payload: payload as Record<string, unknown>,
				updatedAt: new Date(),
			};

			if (previousId) {
				const [updated] = await tx
					.update(draftMessages)
					.set(values)
					.where(
						and(
							eq(draftMessages.id, previousId),
							eq(draftMessages.ownerId, userId),
							eq(draftMessages.status, "draft"),
						),
					)
					.returning({ id: draftMessages.id });
				// Gone (sent or discarded meanwhile): do not resurrect it.
				return { draftId: updated?.id ?? null };
			}

			const [created] = await tx
				.insert(draftMessages)
				.values({ ...values, ownerId: userId, status: "draft" })
				.returning({ id: draftMessages.id });
			return { draftId: created?.id ?? null, created: true };
		});
		// A new draft changes the sidebar draft count.
		if ("created" in result && result.created) await invalidateServerCache();
		return { draftId: result.draftId, error: "error" in result ? result.error : undefined };
	} catch (error) {
		return {
			draftId: previousId,
			error: error instanceof Error ? error.message : "Could not save draft",
		};
	}
}

/** Discards one of the caller's drafts (no-op when it is already gone). */
export async function deleteDraft(draftId: string): Promise<void> {
	if (!draftId || !isUuid(String(draftId))) return;
	const userId = await currentUserId();
	const rls = await rlsClient();
	const deleted = await rls((tx) =>
		tx
			.delete(draftMessages)
			.where(
				and(
					eq(draftMessages.id, String(draftId)),
					eq(draftMessages.ownerId, userId),
					eq(draftMessages.status, "draft"),
				),
			)
			.returning({ id: draftMessages.id }),
	);
	if (deleted.length > 0) await invalidateServerCache();
}

/** The caller's latest reply/forward draft for a message, if any. */
export async function fetchDraftForMessage(
	originalMessageId: string,
	mode?: "reply" | "forward",
): Promise<DraftRow | null> {
	if (!originalMessageId || !isUuid(String(originalMessageId))) return null;
	const userId = await currentUserId();
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({
				id: draftMessages.id,
				mailboxId: draftMessages.mailboxId,
				identityId: draftMessages.identityId,
				payload: draftMessages.payload,
				createdAt: draftMessages.createdAt,
				updatedAt: draftMessages.updatedAt,
			})
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.ownerId, userId),
					eq(draftMessages.status, "draft"),
					sql`${draftMessages.payload}->>'originalMessageId' = ${String(originalMessageId)}`,
					mode ? sql`${draftMessages.payload}->>'mode' = ${mode}` : undefined,
				),
			)
			.orderBy(desc(draftMessages.updatedAt))
			.limit(1),
	);
	return row ? { ...row, payload: row.payload as DraftPayload } : null;
}

/** The caller's drafts of one identity, newest first. */
export async function fetchDrafts(identityPublicId: string): Promise<DraftRow[]> {
	const userId = await currentUserId();
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({
				id: draftMessages.id,
				mailboxId: draftMessages.mailboxId,
				identityId: draftMessages.identityId,
				payload: draftMessages.payload,
				createdAt: draftMessages.createdAt,
				updatedAt: draftMessages.updatedAt,
			})
			.from(draftMessages)
			.innerJoin(identities, eq(identities.id, draftMessages.identityId))
			.where(
				and(
					eq(draftMessages.ownerId, userId),
					eq(draftMessages.status, "draft"),
					eq(identities.publicId, String(identityPublicId ?? "")),
				),
			)
			.orderBy(desc(draftMessages.updatedAt)),
	);
	return rows.map((row) => ({ ...row, payload: row.payload as DraftPayload }));
}

/**
 * Real (non-inline) attachments of a message the caller can read, offered
 * when forwarding it. Inline images are embedded into the quoted original by
 * the worker instead.
 */
export async function fetchForwardableAttachments(
	messageId: string,
): Promise<ForwardableAttachment[]> {
	if (!messageId || !isUuid(String(messageId))) return [];
	await currentUserId();
	const rls = await rlsClient();
	const rows = await rls(async (tx) => {
		const [message] = await tx
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.id, String(messageId)))
			.limit(1);
		if (!message) return [];
		return tx
			.select({
				id: messageAttachments.id,
				path: messageAttachments.path,
				filenameOriginal: messageAttachments.filenameOriginal,
				contentType: messageAttachments.contentType,
				sizeBytes: messageAttachments.sizeBytes,
				isInline: messageAttachments.isInline,
				cid: messageAttachments.cid,
			})
			.from(messageAttachments)
			.where(eq(messageAttachments.messageId, message.id));
	});
	return rows
		.filter((row) => !(row.isInline && row.cid))
		.map((row) => ({
			id: row.id,
			path: row.path,
			filenameOriginal: row.filenameOriginal || "attachment",
			contentType: row.contentType || "application/octet-stream",
			sizeBytes: Number(row.sizeBytes ?? 0),
		}));
}
