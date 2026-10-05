"use server";

import { cache } from "react";
import {getWorkspacePublicId, rlsClient} from "@/lib/actions/clients";
import {
	DraftMessageInsertSchema,
	draftMessages, emailSignatures,
	identities,
	mailboxes,
	mailboxSync, MailboxThreadEntity, type MailSubscriptionEntity,
	mailboxThreads, mailSubscriptions,
	messageAttachments,
	messages,
	threads,
	workspaces,
} from "@db";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
	gt,
} from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	FormState,
	getServerEnv,
	handleAction,
	SearchThreadsResponse,
} from "@schema";
import { decode } from "decode-formdata";
import { toArray } from "@/lib/utils";

import Typesense, { Client } from "typesense";
import { isSignedIn } from "@/lib/actions/auth";
import slugify from "@sindresorhus/slugify";
import { redirect } from "next/navigation";
import { PAGE_SIZE } from "@common/mail-client";
import {
	addJobAndWait,
	DEFAULT_JOB_OPTS,
	enqueueSearchRefresh,
	getQueue,
	getReadyQueue,
	RETRY_JOB_OPTS,
} from "@/lib/actions/get-redis";
import {
	type DeltaFetchResult,
	deltaFetchQueueName,
	deltaFetchQueueOfJob,
	enqueueThreadSmtpJobs,
	isGmailMetaData,
	queueDeltaFetch,
	queueDeltaFetchMany,
	queueGmailBackfill,
	queueImapBackfill,
	queueStopIdle,
	toIdList,
} from "@/lib/mail-jobs";
import { safeFormPost } from "@/lib/safe-url";
import { isOwnUploadKey } from "@/lib/upload-keys";
import dayjs from "dayjs";

import {GetObjectCommand} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "@/lib/create-s3-client";
import {access} from "@/lib/actions/shared";
import {EmailDocument, renderEmailFragment, renderEmailText} from "@email-editor";

let typeSenseClient: Client | null = null;
function getTypeSenseClient(): Client {
	if (typeSenseClient) return typeSenseClient;

	const {
		TYPESENSE_API_KEY,
		TYPESENSE_PORT,
		TYPESENSE_PROTOCOL,
		TYPESENSE_HOST,
	} = getServerEnv();

	typeSenseClient = new Typesense.Client({
		nodes: [
			{
				host: TYPESENSE_HOST,
				port: Number(TYPESENSE_PORT),
				protocol: TYPESENSE_PROTOCOL,
			},
		],
		apiKey: TYPESENSE_API_KEY,
	});

	return typeSenseClient;
}


// Mail actions are server actions and can be called with arbitrary ids, and
// the worker processes their jobs with the service role. RLS only returns
// rows of the caller's workspace, so every id is checked through it before
// anything is queued.

type OwnedMailbox = {
	id: string;
	identityId: string;
	identityPublicId: string;
	workspaceId: string;
	kind: string;
	isDefault: boolean;
	isGmail: boolean;
};

async function findOwnedMailboxes(
	mailboxIds: string[],
): Promise<OwnedMailbox[]> {
	const ids = toIdList(mailboxIds);
	if (!ids.length) return [];
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({
				id: mailboxes.id,
				identityId: mailboxes.identityId,
				identityPublicId: identities.publicId,
				workspaceId: mailboxes.workspaceId,
				kind: mailboxes.kind,
				isDefault: mailboxes.isDefault,
				identityMeta: identities.metaData,
			})
			.from(mailboxes)
			.innerJoin(identities, eq(identities.id, mailboxes.identityId))
			.where(inArray(mailboxes.id, ids)),
	);
	return rows.map(({ identityMeta, ...row }) => ({
		...row,
		kind: String(row.kind),
		isGmail: isGmailMetaData(identityMeta),
	}));
}

/** Throws unless every mailbox is visible through RLS. */
async function requireOwnedMailboxes(
	...mailboxIds: string[]
): Promise<OwnedMailbox[]> {
	const ids = toIdList(mailboxIds);
	if (!ids.length) throw new Error("Mailbox not found");
	const rows = await findOwnedMailboxes(ids);
	if (rows.length !== ids.length) throw new Error("Mailbox not found");
	return ids.map((id) => rows.find((row) => row.id === id)!);
}

/** The identity if it is visible through RLS, else throws. */
async function requireOwnedIdentity(identityId: string) {
	if (!identityId) throw new Error("Identity not found");
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx
			.select({
				id: identities.id,
				publicId: identities.publicId,
				workspaceId: identities.workspaceId,
				smtpAccountId: identities.smtpAccountId,
				metaData: identities.metaData,
				kind: identities.kind,
			})
			.from(identities)
			.where(eq(identities.id, String(identityId)))
			.limit(1),
	);
	if (!identity) throw new Error("Identity not found");
	return identity;
}

/** Thread ids (of `threadIds`) that have rows in this mailbox, via RLS. */
async function ownedThreadIdsInMailbox(mailboxId: string, threadIds: string[]) {
	const ids = toIdList(threadIds);
	if (!ids.length) return [];
	const rls = await rlsClient();
	return rls(async (tx) => {
		const [inThreads, inMessages] = await Promise.all([
			tx
				.select({ threadId: mailboxThreads.threadId })
				.from(mailboxThreads)
				.where(
					and(
						eq(mailboxThreads.mailboxId, mailboxId),
						inArray(mailboxThreads.threadId, ids),
					),
				),
			tx
				.selectDistinct({ threadId: messages.threadId })
				.from(messages)
				.where(
					and(
						eq(messages.mailboxId, mailboxId),
						inArray(messages.threadId, ids),
					),
				),
		]);
		const found = new Set(
			[...inThreads, ...inMessages].map((row) => String(row.threadId)),
		);
		return ids.filter((id) => found.has(id));
	});
}

/** A single message id must belong to the mailbox (and thread, if given). */
async function requireOwnedMessage(
	messageId: string,
	mailboxId: string,
	threadIds?: string[],
) {
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ id: messages.id, threadId: messages.threadId })
			.from(messages)
			.where(and(eq(messages.id, messageId), eq(messages.mailboxId, mailboxId)))
			.limit(1),
	);
	if (!row || (threadIds?.length && !threadIds.includes(String(row.threadId)))) {
		throw new Error("Message not found");
	}
}

export const fetchMailbox = cache(
	async (identityPublicId: string, mailboxSlug = "inbox") => {
		const rls = await rlsClient();

		// One transaction instead of five.
		return rls(async (tx) => {
			const [identity] = await tx
				.select()
				.from(identities)
				.where(eq(identities.publicId, identityPublicId))
				.limit(1);

			if (!identity) throw new Error("Identity not found");

			const mailboxList = await tx
				.select()
				.from(mailboxes)
				.where(eq(mailboxes.identityId, identity.id));

			const activeMailbox = mailboxList.find(
				(mailbox) => mailbox.slug === mailboxSlug,
			);

			if (!activeMailbox) throw new Error("Mailbox not found");

			const [[messagesCountRow], [sync]] = await Promise.all([
				tx
					.select({ count: count() })
					.from(messages)
					.where(eq(messages.mailboxId, activeMailbox.id)),
				tx
					.select()
					.from(mailboxSync)
					.where(eq(mailboxSync.mailboxId, activeMailbox.id))
					.limit(1),
			]);

			return {
				activeMailbox,
				mailboxList,
				identity,
				count: Number(messagesCountRow?.count ?? 0),
				mailboxSync: sync ?? null,
			};
		});
	}
);

export type FetchMailboxResult = Awaited<
	ReturnType<typeof fetchMailbox>
>;



export const fetchIdentityMailboxList = cache(async () => {
	const rls = await rlsClient();

	const rows = await rls((tx) =>
		tx
			.select({ identity: identities, mailbox: mailboxes })
			.from(identities)
			.leftJoin(
				mailboxes,
				and(
					eq(identities.id, mailboxes.identityId),
					sql`${mailboxes.kind} NOT IN ('outbox','drafts')`,
				),
			)
			.where(eq(identities.kind, "email"))
			.orderBy(
				asc(identities.id),
				sql`
					CASE ${mailboxes.kind}
					WHEN 'inbox'   THEN 0
					WHEN 'drafts'  THEN 1
					WHEN 'sent'    THEN 2
					WHEN 'archive' THEN 3
					WHEN 'spam'    THEN 4
					WHEN 'trash'   THEN 5
					WHEN 'outbox'  THEN 6
					ELSE 7
					END
				`,
				asc(mailboxes.parentId),
				sql`lower(coalesce(${mailboxes.name}, ''))`,
			),
	);

	const byIdentity = rows.reduce(
		(acc, r) => {
			const id = r.identity.id;

			if (!acc[id]) {
				acc[id] = {
					identity: r.identity,
					mailboxes: [],
				};
			}

			if (r.mailbox) acc[id].mailboxes.push(r.mailbox);
			return acc;
		},
		{} as Record<
			string,
			{
				identity: typeof identities.$inferSelect;
				mailboxes: (typeof mailboxes.$inferSelect)[];
			}
		>,
	);

	return Object.values(byIdentity);
});


export type FetchIdentityMailboxListResult = Awaited<
	ReturnType<typeof fetchIdentityMailboxList>
>;

export const fetchMailboxUnreadCounts = cache(
	async () => {
		const rls = await rlsClient();
		const now = new Date();

		const unreadAgg = await rls((tx) =>
			tx
				.select({
					mailboxId: mailboxThreads.mailboxId,
					unreadThreads: sql<number>`
						count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)
					`,
					unreadTotal: sql<number>`
						coalesce(sum(${mailboxThreads.unreadCount}), 0)
					`,
				})
				.from(mailboxThreads)
				.where(
					or(
						isNull(mailboxThreads.snoozedUntil),
						lte(mailboxThreads.snoozedUntil, now)
					)
				)
				.groupBy(mailboxThreads.mailboxId)
		);

		return new Map<
			string,
			{ unreadThreads: number; unreadTotal: number }
		>(
			unreadAgg.map((a) => [
				a.mailboxId,
				{
					unreadThreads: Number(a.unreadThreads ?? 0),
					unreadTotal: Number(a.unreadTotal ?? 0),
				},
			])
		);
	}
);


export type FetchMailboxUnreadCountsResult = Awaited<
	ReturnType<typeof fetchMailboxUnreadCounts>
>;

export const fetchMessageAttachments = cache(async (messageId: string) => {
	const rls = await rlsClient();
	const attachmentsList = await rls((tx) =>
		tx
			.select()
			.from(messageAttachments)
			.where(eq(messageAttachments.messageId, messageId))
			.orderBy(desc(messageAttachments.createdAt)),
	);
	return { attachments: attachmentsList };
});

export async function getSignedUrlsForMessage(messageId: string) {
	const { S3_BUCKET } = getServerEnv();
	const rls = await rlsClient();
	const attachments = await rls((tx) =>
		tx
			.select()
			.from(messageAttachments)
			.where(eq(messageAttachments.messageId, messageId)),
	);
	const results = await Promise.all(
		attachments.map(async (attachment) => {
			const command = new GetObjectCommand({
				Bucket: S3_BUCKET!,
				Key: attachment.path!,
			});

			const url = await getSignedUrl(s3, command, { expiresIn: 300 });

			return {
				...attachment,
				signedUrl: url,
			};
		}),
	);
	return results;
}

export const revalidateMailbox = async (path: string) => {
	revalidatePath(path);
};

const isSignaturePublicId = (
	value: string,
) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);




const SENT_MAILBOX_NAMES = [
	"sent",
	"sent items",
	"sent mail",
	"sent messages",
	"gesendet",
	"gesendete objekte",
	"gesendete elemente",
	"gesendete nachrichten",
];

type MailboxRow = typeof mailboxes.$inferSelect;

/**
 * The identity's Sent folder: kind "sent" first, then the usual slugs and
 * names. IMAP servers without SPECIAL-USE flags (e.g. many German hosts with
 * a "Gesendet" folder) otherwise end up without a sent mailbox and every
 * send fails.
 */
function resolveSentMailbox(boxes: MailboxRow[]) {
	const normalized = (value?: string | null) =>
		String(value ?? "")
			.trim()
			.toLowerCase();
	return (
		boxes.find((box) => box.kind === "sent") ??
		boxes.find((box) => SENT_MAILBOX_NAMES.includes(normalized(box.slug))) ??
		boxes.find((box) => SENT_MAILBOX_NAMES.includes(normalized(box.name))) ??
		boxes.find((box) => {
			const name = normalized(box.name);
			return name.includes("sent") || name.includes("gesendet");
		})
	);
}

/** Attachments may only come from the caller's own upload folder. */
function assertOwnUploadPaths(attachments: unknown, userId: string) {
	if (attachments === undefined || attachments === null || attachments === "") {
		return;
	}
	let list: unknown;
	try {
		list =
			typeof attachments === "string" ? JSON.parse(attachments) : attachments;
	} catch {
		throw new Error("Invalid attachments payload");
	}
	if (!Array.isArray(list)) throw new Error("Invalid attachments payload");
	for (const item of list as Array<{ path?: unknown }>) {
		if (!item?.path) continue;
		if (!isOwnUploadKey(String(item.path), userId)) {
			throw new Error("Invalid attachment");
		}
	}
}

export async function sendMail(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const decodedForm =
		decode(formData) as any;

	const user = await isSignedIn();
	if (!user?.id) {
		return { success: false, error: "Unauthorized" };
	}

	const rls = await rlsClient();

	const identity = await rls(
		async (tx) => {
			const [identity] = await tx
				.select()
				.from(identities)
				.where(
					eq(
						identities.publicId,
						String(decodedForm.identityPublicId ?? ""),
					),
				)
				.limit(1);

			return identity;
		},
	);

	if (!identity) {
		return {
			success: false,
			error: "Identity not found.",
		};
	}

	const boxes = await rls(
		async (tx) =>
			tx
				.select()
				.from(mailboxes)
				.where(
					eq(
						mailboxes.identityId,
						identity.id,
					),
				),
	);

	const sentMailbox = resolveSentMailbox(boxes);

	const inboxMailbox = boxes.find(
		(box) => box.kind === "inbox",
	);

	if (
		!sentMailbox ||
		!inboxMailbox
	) {
		return {
			success: false,
			error:
				"Required mailboxes (inbox and sent) not found for the identity.",
		};
	}

	// Server-resolved ids always win over anything the form sent.
	decodedForm.sentMailboxId =
		sentMailbox.id;
	decodedForm.mailboxId =
		inboxMailbox.id;
	decodedForm.identityId =
		identity.id;

	// The worker loads the original message with the service role, quotes
	// it and files the reply into its thread: it must be the caller's.
	const originalMessageId = String(decodedForm.originalMessageId ?? "").trim();
	if (originalMessageId && originalMessageId !== "undefined" && originalMessageId !== "null") {
		const [original] = await rls((tx) =>
			tx
				.select({ id: messages.id })
				.from(messages)
				.where(eq(messages.id, originalMessageId))
				.limit(1),
		).catch(() => [] as { id: string }[]);
		if (!original) {
			return {
				success: false,
				error: "Original message not found.",
			};
		}
		decodedForm.originalMessageId = original.id;
	} else {
		delete decodedForm.originalMessageId;
	}

	try {
		assertOwnUploadPaths(decodedForm.attachments, user.id);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Invalid attachment",
		};
	}

	if (
		toArray(
			decodedForm.to as any,
		).length === 0
	) {
		return {
			success: false,
			error:
				"Please provide at least one recipient in the To field.",
		};
	}

	const signaturePublicId =
		typeof decodedForm.signaturePublicId ===
		"string"
			? decodedForm.signaturePublicId.trim()
			: "";

	if (signaturePublicId) {
		if (
			!isSignaturePublicId(
				signaturePublicId,
			)
		) {
			return {
				success: false,
				error:
					"Invalid email signature.",
			};
		}

		const signature = await rls(
			async (tx) => {
				const [result] = await tx
					.select({
						document:
						emailSignatures.document,
					})
					.from(emailSignatures)
					.where(
						and(
							eq(
								emailSignatures.publicId,
								signaturePublicId,
							),
							eq(
								emailSignatures.identityId,
								identity.id,
							),
						),
					)
					.limit(1);

				return result;
			},
		);

		if (!signature) {
			return {
				success: false,
				error:
					"Email signature not found for this identity.",
			};
		}

		const signatureDocument =
			signature.document as unknown as EmailDocument;

		const signatureHtml =
			renderEmailFragment(
				signatureDocument,
			).trim();

		const signatureText =
			renderEmailText(
				signatureDocument,
			).trim();

		const messageHtml =
			typeof decodedForm.html ===
			"string"
				? decodedForm.html
				: "";

		const messageText =
			typeof decodedForm.text ===
			"string"
				? decodedForm.text
				: "";

		if (signatureHtml) {
			decodedForm.html = [
				messageHtml,
				messageHtml.trim()
					? "<br>"
					: "",
				`<div data-kurrier-signature="true">${signatureHtml}</div>`,
			].join("");
		}

		if (signatureText) {
			decodedForm.text = [
				messageText.trimEnd(),
				signatureText,
			]
				.filter(Boolean)
				.join("\n\n");
		}
	}

	/*
     * The payload now contains the rendered
     * signature. Scheduled mail therefore
     * preserves the signature as it appeared
     * when the message was scheduled.
     */
	const scheduledAtRaw =
		decodedForm.scheduledAt
			? String(
				decodedForm.scheduledAt,
			)
			: "";

	if (scheduledAtRaw) {
		const scheduledAt = dayjs(
			scheduledAtRaw,
		);

		if (!scheduledAt.isValid()) {
			return {
				success: false,
				error:
					"Invalid scheduled time.",
			};
		}

		const parsed =
			DraftMessageInsertSchema.safeParse(
				{
					identityId:
					identity.id,
					mailboxId:
					decodedForm.mailboxId,
					payload:
					decodedForm,
					status: "scheduled",
					scheduledAt:
						scheduledAt.toDate(),
				},
			);

		if (!parsed.success) {
			return {
				success: false,
				error:
					"There was an error trying to schedule your mail.",
			};
		}

		const row = await rls(
			async (tx) => {
				const [created] =
					await tx
						.insert(
							draftMessages,
						)
						.values(
							parsed.data,
						)
						.returning({
							id: draftMessages.id,
							scheduledAt:
							draftMessages.scheduledAt,
						});

				return created ?? null;
			},
		);

		if (
			!row?.id ||
			!row.scheduledAt
		) {
			return {
				success: false,
				error:
					"Failed to schedule your mail.",
			};
		}

		const delay = Math.max(
			0,
			Number(
				new Date(
					row.scheduledAt,
				),
			) -
			Number(new Date()),
		);

		try {
			await getQueue("send-mail").add(
				"send-scheduled-draft",
				{
					draftMessageId: row.id,
				},
				{
					jobId: row.id,
					delay,
					removeOnComplete: true,
					removeOnFail: { age: 7 * 24 * 3600 },
				},
			);
		} catch (error) {
			console.error("Failed to queue scheduled mail", error);
			// Do not leave a scheduled draft behind that will never be sent.
			await rls((tx) =>
				tx.delete(draftMessages).where(eq(draftMessages.id, row.id)),
			).catch(() => {});
			return {
				success: false,
				error: "Mail queue is unavailable. Please retry in a moment.",
			};
		}

		revalidatePath(
			"/dashboard/mail",
		);

		return {
			success: true,
			data: {
				draftMessageId: row.id,
			},
		};
	}

	try {
		return await addJobAndWait<FormState>(
			"send-mail",
			"send-and-reconcile",
			decodedForm,
			{
				removeOnComplete: true,
				removeOnFail: { age: 24 * 3600 },
			},
		);
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error ? error.message : "Failed to send email.",
		};
	}
}

const SYNC_QUEUE_UNAVAILABLE =
	"Sync queue is unavailable. Please retry in a moment.";

/**
 * Start a delta sync for one identity without waiting for it. The returned
 * jobId can be polled with getDeltaFetchStatus.
 */
export const deltaFetch = async ({
	identityId,
}: {
	identityId: string;
}): Promise<DeltaFetchResult> => {
	const identity = await requireOwnedIdentity(identityId);

	if (!(await canSyncWorkspace())) {
		console.info(
			`[delta-fetch:${identityId}] mail sync disabled for workspace ${identity.workspaceId}`,
		);
		return {
			success: false,
			jobId: null,
			queue: null,
			state: "disabled",
			error: "Mail sync is disabled for this workspace.",
		};
	}

	try {
		return await queueDeltaFetch(identity);
	} catch (error) {
		console.error("Failed to enqueue delta-fetch job", error);
		return {
			success: false,
			jobId: null,
			queue: null,
			state: "failed",
			error: SYNC_QUEUE_UNAVAILABLE,
		};
	}
};

export type DeltaFetchAllResult = {
	success: boolean;
	queued: number;
	failed: number;
	jobIds: string[];
	error: string | null;
};

/** Start a delta sync for every synced mail identity of the workspace. */
export const deltaFetchAllMailboxes = async (): Promise<DeltaFetchAllResult> => {
	const empty = { queued: 0, failed: 0, jobIds: [] as string[] };
	try {
		if (!(await canSyncWorkspace())) {
			return {
				success: false,
				...empty,
				error: "Mail sync is disabled for this workspace.",
			};
		}

		const rls = await rlsClient();
		const rows = await rls((tx) =>
			tx
				.select({
					id: identities.id,
					workspaceId: identities.workspaceId,
					smtpAccountId: identities.smtpAccountId,
					metaData: identities.metaData,
				})
				.from(identities)
				.where(eq(identities.kind, "email")),
		);

		const { jobIds, failed } = await queueDeltaFetchMany(rows);

		return {
			success: failed === 0,
			queued: jobIds.length,
			failed,
			jobIds,
			error:
				failed > 0
					? `${failed} sync job${failed === 1 ? "" : "s"} could not be queued.`
					: null,
		};
	} catch (error) {
		console.error("Failed to enqueue all mailbox sync jobs", error);
		return { success: false, ...empty, error: SYNC_QUEUE_UNAVAILABLE };
	}
};

export type DeltaFetchStatus = {
	success: boolean;
	jobId: string;
	/** BullMQ job state, or "missing" once the job was cleaned up. */
	state: string;
	error: string | null;
};

/** Poll a job started by deltaFetch / deltaFetchAllMailboxes. */
export const getDeltaFetchStatus = async ({
	jobId,
}: {
	jobId: string;
}): Promise<DeltaFetchStatus> => {
	const id = String(jobId ?? "");
	const queue = deltaFetchQueueOfJob(id);
	if (!queue) {
		return { success: false, jobId: id, state: "missing", error: "Unknown sync job." };
	}

	try {
		const job = await (
			await getReadyQueue(deltaFetchQueueName(queue))
		).getJob(id);

		if (!job) {
			return {
				success: false,
				jobId: id,
				state: "missing",
				error: "Sync job was not found. It may already have been cleaned up.",
			};
		}

		// Only report jobs of identities the caller can see.
		const owned = await findOwnedIdentityId(String(job.data?.identityId ?? ""));
		if (!owned) {
			return { success: false, jobId: id, state: "missing", error: "Unknown sync job." };
		}

		const state = await job.getState();
		return {
			success: state !== "failed",
			jobId: id,
			state,
			error: state === "failed" ? job.failedReason || "Sync failed." : null,
		};
	} catch (error) {
		console.error("Failed to read delta-fetch job status", error);
		return {
			success: false,
			jobId: id,
			state: "failed",
			error: SYNC_QUEUE_UNAVAILABLE,
		};
	}
};

async function findOwnedIdentityId(identityId: string) {
	if (!identityId) return null;
	try {
		return (await requireOwnedIdentity(identityId)).id;
	} catch {
		return null;
	}
}

/**
 * Full-text search. The workspace and identity are resolved server-side
 * through RLS; the `workspacePublicId` argument is ignored (kept for call
 * compatibility) because the search index is queried with the admin key.
 */
export const initSearch = async (
	query: string,
	_workspacePublicId: string,
	identityPublicId: string,
	mailboxSlug: string,
	hasAttachment: boolean,
	onlyUnread: boolean,
	starred: boolean,
	page: number,
): Promise<SearchThreadsResponse> => {
	const empty = { items: [], totalThreads: 0, totalMessages: 0 };
	const q = String(query ?? "").trim();
	if (!q) {
		return empty;
	}

	const rls = await rlsClient();
	const [scope] = await rls((tx) =>
		tx
			.select({
				identityPublicId: identities.publicId,
				workspacePublicId: workspaces.publicId,
			})
			.from(identities)
			.innerJoin(workspaces, eq(workspaces.id, identities.workspaceId))
			.where(eq(identities.publicId, String(identityPublicId ?? "")))
			.limit(1),
	);
	if (!scope) return empty;

	const client = getTypeSenseClient();

	const filters = [
		`workspacePublicId:=${JSON.stringify(scope.workspacePublicId)}`,
		`identityPublicId:=${JSON.stringify(scope.identityPublicId)}`,
		`mailboxSlug:=${JSON.stringify(String(mailboxSlug ?? ""))}`,
	];

	if (hasAttachment) filters.push("hasAttachment:=1");
	if (onlyUnread) filters.push("unread:=1");
	if (starred) filters.push("starred:=1");

	const result = (await client.collections("messages").documents().search({
		q,
		query_by: "subject,html,text,snippet,fromName,fromEmail,participants",
		filter_by: filters.join(" && "),
		sort_by: "createdAt:desc",
		group_by: "threadId",
		group_limit: 1,
		per_page: PAGE_SIZE,
		page: Math.max(1, Math.floor(Number(page) || 1)),
	})) as any;

	const groups = result?.grouped_hits as
		| Array<{ group_key: string[]; hits: Array<{ document: any }> }>
		| undefined;

	const sourceHits = groups?.length
		? groups.map((g) => g.hits[0]?.document ?? {})
		: (result?.hits ?? []).map((h: any) => h.document ?? {});

	return {
		items: sourceHits.map((d: any) => ({
			id: d.id ?? "",
			threadId: d.threadId ?? "",
			subject: d.subject ?? null,
			snippet: (d.snippet ?? d.text ?? "").slice(0, 200),
			fromName: d.fromName ?? null,
			fromEmail: d.fromEmail ?? null,
			participants: Array.isArray(d.participants) ? d.participants : [],
			labels: Array.isArray(d.labels) ? d.labels : [],
			hasAttachment: Number(d.hasAttachment) === 1,
			unread: Number(d.unread) === 1,
			starred: Number(d.starred) === 1,
			createdAt: d.createdAt ?? 0,
			lastInThreadAt: d.lastInThreadAt ?? d.createdAt ?? 0,
		})),
		totalThreads: result?.found ?? sourceHits.length,
		totalMessages: result?.found_docs ?? sourceHits.length,
	};
};


async function canSyncWorkspace(): Promise<boolean> {
	const { canSyncMail } = await access("canSyncMail");
	return canSyncMail;
}

/**
 * IMAP backfill for an identity of the caller's workspace. The workspace id
 * argument is ignored in favour of the identity's own (kept for call
 * compatibility).
 */
export const backfillMailboxes = async (identityId: string, _workspaceId?: string) => {
	const identity = await requireOwnedIdentity(identityId);
	if (!(await canSyncWorkspace())) {
		console.info(
			`[backfill:${identityId}] mail sync disabled for workspace ${identity.workspaceId}`,
		);
		return;
	}

	await queueImapBackfill(identity.id, identity.workspaceId);
};

export const backfillGoogleMailboxes = async (
	identityId: string,
	_workspaceId?: string,
) => {
	const identity = await requireOwnedIdentity(identityId);
	if (!(await canSyncWorkspace())) {
		console.info(
			`[backfill:${identityId}] mail sync disabled for workspace ${identity.workspaceId}`,
		);
		return;
	}

	await queueGmailBackfill(identity.id, identity.workspaceId);
};

export const fetchWebMailThreadDetail = cache(async (threadId: string) => {
	const rls = await rlsClient();
	const result = await rls(async (tx) => {
		const rows = await tx
			.select({
				thread: threads,
				message: messages,
			})
			.from(threads)
			.innerJoin(messages, eq(messages.threadId, threads.id))
			.where(eq(threads.id, threadId))
			.orderBy(asc(sql`coalesce(${messages.date}, ${messages.createdAt})`));

		if (rows.length === 0) {
			return {
				thread: null,
				messages: [] as (typeof rows)[number]["message"][],
			};
		}

		const thread = rows[0].thread;
		const msgs = rows.map((r) => r.message);
		return { thread, messages: msgs };
	});
	return result;
});

/** The database is already updated; a missed re-index must not fail the action. */
async function refreshSearchBestEffort(threadIds: string[]) {
	try {
		await enqueueSearchRefresh(threadIds);
	} catch (error) {
		console.error("Failed to queue search refresh", error);
	}
}

/**
 * Update seen state through RLS. Only rows of the caller's workspace are
 * touched, so the returned thread ids (from both the messages and the
 * mailbox_threads rows) are exactly the ones the worker may act on.
 */
async function setThreadsSeen(
	ids: string[],
	mailboxId: string,
	seen: boolean,
): Promise<{ mailbox: OwnedMailbox | null; threadIds: string[] }> {
	const [mailbox] = await findOwnedMailboxes([mailboxId]);
	if (!mailbox) return { mailbox: null, threadIds: [] };

	const now = new Date();
	const rls = await rlsClient();

	const threadIds = await rls(async (tx) => {
		const updatedMessages = await tx
			.update(messages)
			.set({ seen, updatedAt: now })
			.where(
				and(inArray(messages.threadId, ids), eq(messages.mailboxId, mailboxId)),
			)
			.returning({ threadId: messages.threadId });

		// One statement for all threads. Unread falls back to 1 so the thread
		// shows up as unread even when no message row matched.
		const updatedThreads = await tx
			.update(mailboxThreads)
			.set({
				unreadCount: seen
					? 0
					: sql`greatest(1, (
						select count(*) from ${messages}
						where ${messages.threadId} = ${mailboxThreads.threadId}
						and ${messages.mailboxId} = ${mailboxThreads.mailboxId}
						and ${messages.seen} = false
					))`,
				updatedAt: now,
			})
			.where(
				and(
					inArray(mailboxThreads.threadId, ids),
					eq(mailboxThreads.mailboxId, mailboxId),
				),
			)
			.returning({ threadId: mailboxThreads.threadId });

		return Array.from(
			new Set(
				[...updatedMessages, ...updatedThreads].map((row) =>
					String(row.threadId),
				),
			),
		);
	});

	return { mailbox, threadIds };
}

async function markThreadsSeen(
	threadIds: string | string[],
	mailboxId: string,
	markSmtp: boolean,
	refresh: boolean,
	seen: boolean,
) {
	const ids = toIdList(threadIds);
	if (!ids.length || !mailboxId) return;

	const { mailbox, threadIds: ownedIds } = await setThreadsSeen(
		ids,
		mailboxId,
		seen,
	);
	if (!mailbox || !ownedIds.length) return;

	if (markSmtp || mailbox.isGmail) {
		// The worker sets the flag on the server and re-indexes the thread.
		await enqueueThreadSmtpJobs("mail:set-flags", ownedIds, () => ({
			mailboxId,
			op: seen ? "read" : "unread",
		}));
	} else {
		await refreshSearchBestEffort(ownedIds);
	}

	if (refresh) revalidatePath("/");
}

export const markAsRead = async (
	threadIds: string | string[],
	mailboxId: string,
	markSmtp: boolean,
	refresh = true,
) => markThreadsSeen(threadIds, mailboxId, markSmtp, refresh, true);

export const markAsUnread = async (
	threadIds: string | string[],
	mailboxId: string,
	markSmtp: boolean,
	refresh: boolean,
) => markThreadsSeen(threadIds, mailboxId, markSmtp, refresh, false);

async function moveThreadsToSystemFolder(
	op: "trash" | "spam",
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
	messageId?: string,
) {
	const ids = toIdList(threadIds);
	if (!ids.length || !mailboxId) return;

	await requireOwnedMailboxes(mailboxId);
	const ownedIds = await ownedThreadIdsInMailbox(mailboxId, ids);
	if (!ownedIds.length) return;
	if (messageId) await requireOwnedMessage(messageId, mailboxId, ownedIds);

	await Promise.all([
		enqueueThreadSmtpJobs("mail:move", ownedIds, () => ({
			mailboxId,
			op,
			messageId,
			moveImap,
		})),
		enqueueSearchRefresh(ownedIds),
	]);

	if (refresh) {
		revalidatePath("/mail");
	}
}

export const moveToTrash = async (
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
	messageId?: string,
) =>
	moveThreadsToSystemFolder(
		"trash",
		threadIds,
		mailboxId,
		moveImap,
		refresh,
		messageId,
	);

export const moveToSpam = async (
	threadIds: string | string[],
	mailboxId: string,
	moveImap: boolean,
	refresh: boolean,
	messageId?: string,
) =>
	moveThreadsToSystemFolder(
		"spam",
		threadIds,
		mailboxId,
		moveImap,
		refresh,
		messageId,
	);

/**
 * Star or unstar threads. The database is updated through RLS right away;
 * for IMAP/Gmail mailboxes the worker then sets the flag on the server.
 */
export const setStarForThreads = async (
	threadIds: string | string[],
	mailboxId: string,
	starred: boolean,
	starImap: boolean,
	refresh = true,
) => {
	const ids = toIdList(threadIds);
	if (!ids.length || !mailboxId) return;

	const [mailbox] = await requireOwnedMailboxes(mailboxId);
	const now = new Date();
	const rls = await rlsClient();

	const ownedIds = await rls(async (tx) => {
		const updatedMessages = await tx
			.update(messages)
			.set({ flagged: starred, updatedAt: now })
			.where(
				and(inArray(messages.threadId, ids), eq(messages.mailboxId, mailboxId)),
			)
			.returning({ threadId: messages.threadId });

		const updatedThreads = await tx
			.update(mailboxThreads)
			.set({ starred, updatedAt: now })
			.where(
				and(
					inArray(mailboxThreads.threadId, ids),
					eq(mailboxThreads.mailboxId, mailboxId),
				),
			)
			.returning({ threadId: mailboxThreads.threadId });

		return Array.from(
			new Set(
				[...updatedMessages, ...updatedThreads].map((row) =>
					String(row.threadId),
				),
			),
		);
	});
	if (!ownedIds.length) return;

	if (starImap || mailbox.isGmail) {
		await enqueueThreadSmtpJobs(
			"mail:set-flags",
			ownedIds,
			() => ({ mailboxId, op: starred ? "flag" : "unflag" }),
			() => ({ ...DEFAULT_JOB_OPTS, removeOnFail: true }),
		);
	} else {
		await refreshSearchBestEffort(ownedIds);
	}

	if (refresh) revalidatePath("/");
};

/** Toggle the star of one thread; `starred` is its current state. */
export const toggleStar = async (
	threadId: string,
	mailboxId: string,
	starred: boolean,
	starImap: boolean,
) => {
	if (!threadId || !mailboxId) return;
	await setStarForThreads([threadId], mailboxId, !starred, starImap, true);
};

export const fetchMailboxThreads = async (
	identityPublicId: string,
	mailboxSlug: string,
	page: number,
) => {
	const rls = await rlsClient();
	const now = new Date();
	const safePage = page && page > 0 ? page : 1;

	const effectiveActivityAt = sql`
		COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt})
	`;

	const rows = await rls((tx) =>
		tx
			.select({ thread: mailboxThreads })
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.identityPublicId, identityPublicId),
					eq(mailboxThreads.mailboxSlug, mailboxSlug),
					or(
						isNull(mailboxThreads.snoozedUntil),
						lte(mailboxThreads.snoozedUntil, now),
					),
				),
			)
			.orderBy(
				desc(effectiveActivityAt),
				desc(mailboxThreads.lastActivityAt),
				desc(mailboxThreads.threadId),
			)
			.offset((safePage - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
	);

	return rows.map((r) => r.thread);
};

export type FetchMailboxThreadsResult = Awaited<
	ReturnType<typeof fetchMailboxThreads>
>;

export type FetchMailboxThreadsByIdsResult = {
	threads: (typeof mailboxThreads.$inferSelect)[];
	missing?: string[];
};

export async function fetchMailboxThreadsList(
	mailboxId: string,
	threadIds: string[],
): Promise<FetchMailboxThreadsByIdsResult> {
	if (!threadIds?.length) return { threads: [] };

	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select()
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.mailboxId, mailboxId),
					inArray(mailboxThreads.threadId, threadIds),
				),
			),
	);

	const rank = new Map(threadIds.map((id, i) => [id, i]));
	rows.sort(
		(a, b) =>
			(rank.get(a.threadId) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.threadId) ?? Number.MAX_SAFE_INTEGER),
	);

	const found = new Set(rows.map((r) => r.threadId));
	const missing = threadIds.filter((id) => !found.has(id));

	return { threads: rows, missing };
}

export async function deleteForever(
	threadIds: string | string[] | null,
	mailboxId: string,
	imapDelete: boolean,
	refresh = true,
	opts?: { emptyAll?: boolean },
) {
	const user = await isSignedIn();

	if (!user?.id) {
		throw new Error("Unauthorized");
	}

	if (!mailboxId) {
		throw new Error("Mailbox is required");
	}

	const rls = await rlsClient();
	const { emptyAll = false } = opts ?? {};

	// Verify that this mailbox is accessible to the current user/workspace.
	const [allowedMailbox] = await rls((tx) =>
		tx
			.select({
				id: mailboxes.id,
				identityId: mailboxes.identityId,
			})
			.from(mailboxes)
			.innerJoin(
				identities,
				eq(mailboxes.identityId, identities.id),
			)
			.where(eq(mailboxes.id, mailboxId))
			.limit(1),
	);

	if (!allowedMailbox) {
		throw new Error("Mailbox not found or access denied");
	}

	if (emptyAll) {
		await getQueue("smtp-worker").add(
			"mail:delete-permanent",
			{
				mailboxId: allowedMailbox.id,
				emptyAll: true,
				imapDelete,
			},
			{
				attempts: 3,
				backoff: {
					type: "exponential",
					delay: 1500,
				},
				removeOnComplete: true,
				removeOnFail: true,
			},
		);

		if (refresh) {
			revalidatePath("/mail");
		}

		return;
	}

	const requestedIds = (
		Array.isArray(threadIds)
			? threadIds
			: [threadIds]
	)
		.filter(Boolean)
		.map(String);

	if (!requestedIds.length) {
		return;
	}

	const allowedThreads = await rls((tx) =>
		tx
			.select({
				threadId: mailboxThreads.threadId,
			})
			.from(mailboxThreads)
			.where(
				and(
					eq(mailboxThreads.mailboxId, allowedMailbox.id),
					inArray(mailboxThreads.threadId, requestedIds),
				),
			),
	);

	const allowedIds = allowedThreads.map((row) => row.threadId);

	if (allowedIds.length !== requestedIds.length) {
		throw new Error("One or more threads were not found or access was denied");
	}

	await Promise.all([
		enqueueThreadSmtpJobs(
			"mail:delete-permanent",
			allowedIds,
			() => ({ mailboxId: allowedMailbox.id, imapDelete }),
			() => ({ ...DEFAULT_JOB_OPTS, removeOnFail: true }),
		),
		enqueueSearchRefresh(allowedIds),
	]);

	if (refresh) {
		revalidatePath("/mail");
	}
}

export async function addNewMailboxFolder(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData);
		const user = await isSignedIn();
		if (!user?.id) return { success: false, error: "Unauthorized" };

		const name = String(decodedForm.name ?? "").trim();
		if (!name) return { success: false, error: "mailbox.folderNameRequired" };

		// The identity and parent come from the form: check both through RLS.
		const identity = await requireOwnedIdentity(String(decodedForm.identityId ?? ""));
		const parentId =
			decodedForm.parentId && decodedForm.parentId !== "none"
				? String(decodedForm.parentId)
				: null;

		if (parentId) {
			const [parent] = await findOwnedMailboxes([parentId]);
			if (!parent || parent.identityId !== identity.id) {
				return { success: false, error: "mailbox.invalidParentFolder" };
			}
		}

		// IMAP or not is a property of the identity, not of the request.
		if (identity.smtpAccountId) {
			await addJobAndWait(
				"smtp-worker",
				"mailbox:add-new",
				{
					name,
					parentId,
					identityId: identity.id,
					workspaceId: identity.workspaceId,
					ownerId: user.id,
					kind: "custom",
					slug: slugify(name),
				},
				{ ...RETRY_JOB_OPTS, removeOnComplete: true, removeOnFail: true },
			);
		} else {
			const rls = await rlsClient();
			await rls((tx) =>
				tx.insert(mailboxes).values({
					ownerId: user.id,
					workspaceId: identity.workspaceId,
					identityId: identity.id,
					parentId,
					kind: "custom",
					name,
					slug: slugify(name.toLowerCase()),
					isDefault: false,
					metaData: {},
				}),
			);
		}

		revalidatePath("/dashboard/mail");
		return { success: true };
	});
}

export async function deleteMailboxFolder({
	imapOp: _imapOp,
	identityId: identityPublicId,
	mailboxId,
}: {
	imapOp: boolean;
	/** Public id of the identity. */
	identityId: string;
	mailboxId: string;
}): Promise<FormState> {
	const user = await isSignedIn();
	if (!user?.id) return { success: false, error: "Unauthorized" };

	const rls = await rlsClient();
	const [mailbox] = await rls((tx) =>
		tx
			.select({
				id: mailboxes.id,
				isDefault: mailboxes.isDefault,
				identityId: identities.id,
				smtpAccountId: identities.smtpAccountId,
			})
			.from(mailboxes)
			.innerJoin(identities, eq(identities.id, mailboxes.identityId))
			.where(
				and(
					eq(mailboxes.id, String(mailboxId)),
					eq(identities.publicId, String(identityPublicId)),
				),
			)
			.limit(1),
	).catch(() => []);

	if (!mailbox) return { success: false, error: "Folder not found" };
	if (mailbox.isDefault)
		return { success: false, error: "Cannot delete a default folder" };

	if (!mailbox.smtpAccountId) {
		// Sub-folders and sync rows go with it (ON DELETE CASCADE).
		await rls((tx) =>
			tx
				.delete(mailboxes)
				.where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.isDefault, false))),
		);

		revalidatePath("/dashboard/mail");
		return { success: true };
	}

	await addJobAndWait(
		"smtp-worker",
		"mailbox:delete-folder",
		{
			mailboxId: mailbox.id,
			identityId: mailbox.identityId,
			ownerId: user.id,
		},
		{ ...RETRY_JOB_OPTS, removeOnComplete: true, removeOnFail: true },
	);

	const workspacePublicId = await getWorkspacePublicId();
	redirect(
		workspacePublicId
			? `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/inbox`
			: "/",
	);
}

export const moveToFolder = async (
	threadIds: string | string[],
	fromMailboxId: string, // current mailbox
	toMailboxId: string, // destination mailbox (UUID)
	moveImap: boolean, // perform IMAP move when true
	refresh: boolean,
	messageId?: string,
) => {
	const ids = toIdList(threadIds);

	if (
		!ids.length ||
		!fromMailboxId ||
		!toMailboxId ||
		fromMailboxId === toMailboxId
	)
		return;

	await requireOwnedMailboxes(fromMailboxId, toMailboxId);
	const ownedIds = await ownedThreadIdsInMailbox(fromMailboxId, ids);
	if (!ownedIds.length) return;
	if (messageId) await requireOwnedMessage(messageId, fromMailboxId, ownedIds);

	await Promise.all([
		enqueueThreadSmtpJobs(
			"mail:move",
			ownedIds,
			() => ({
				mailboxId: fromMailboxId,
				op: "move",
				toMailboxId,
				messageId,
				moveImap,
			}),
			(threadId) => ({
				...DEFAULT_JOB_OPTS,
				jobId: `move:${threadId}:${fromMailboxId}->${toMailboxId}`,
			}),
		),
		enqueueSearchRefresh(ownedIds),
	]);

	if (refresh) revalidatePath("/mail");
};

export const clearImapClients = async (identityId: string) => {
	const identity = await requireOwnedIdentity(identityId);
	await queueStopIdle(identity.id);
};

export const fetchScheduledDraftCounts = cache(async () => {
	const rls = await rlsClient();

	const rows = await rls((tx) =>
		tx
			.select()
			.from(draftMessages)
			.where(
				eq(draftMessages.status, "scheduled")
			)
	);

	return rows;
});

/**
 * Sidebar counts per identity id, without loading draft payloads or whole
 * thread rows (use this instead of fetchScheduledDraftCounts /
 * fetchIdentitySnoozedThreads when only the numbers are needed).
 */
export const fetchMailSidebarCounts = cache(
	async (): Promise<{
		scheduledByIdentityId: Record<string, number>;
		snoozedByIdentityId: Record<string, number>;
	}> => {
		const rls = await rlsClient();
		const now = new Date();

		const [scheduled, snoozed] = await rls((tx) =>
			Promise.all([
				tx
					.select({
						identityId: draftMessages.identityId,
						count: count(),
					})
					.from(draftMessages)
					.where(eq(draftMessages.status, "scheduled"))
					.groupBy(draftMessages.identityId),
				tx
					.select({
						identityId: mailboxThreads.identityId,
						count: count(),
					})
					.from(mailboxThreads)
					.where(
						and(
							isNotNull(mailboxThreads.snoozedUntil),
							gt(mailboxThreads.snoozedUntil, now),
						),
					)
					.groupBy(mailboxThreads.identityId),
			]),
		);

		const toRecord = (rows: { identityId: string | null; count: number }[]) =>
			Object.fromEntries(
				rows
					.filter((row) => row.identityId)
					.map((row) => [String(row.identityId), Number(row.count)]),
			);

		return {
			scheduledByIdentityId: toRecord(scheduled),
			snoozedByIdentityId: toRecord(snoozed),
		};
	},
);

export type FetchMailSidebarCountsResult = Awaited<
	ReturnType<typeof fetchMailSidebarCounts>
>;


export const fetchScheduledDrafts = async (identityPublicId: string) => {
	const rls = await rlsClient();
	// One transaction; an unknown identity yields an empty list.
	return rls(async (tx) => {
		const [identity] = await tx
			.select({ id: identities.id })
			.from(identities)
			.where(eq(identities.publicId, identityPublicId))
			.limit(1);
		if (!identity) return [];
		return tx
			.select()
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.status, "scheduled"),
					eq(draftMessages.identityId, identity.id),
				),
			);
	});
};

export async function deleteScheduledDraft(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData) as Record<string, unknown>;
		const rls = await rlsClient();
		const deleted = await rls((tx) =>
			tx
				.delete(draftMessages)
				.where(eq(draftMessages.id, String(decodedForm.draftId)))
				.returning({ id: draftMessages.id }),
		);

		// Drop the delayed send job too (its id is the draft id).
		for (const row of deleted) {
			await getQueue("send-mail")
				.remove(String(row.id))
				.catch(() => 0);
		}

		revalidatePath("/dashboard/mail");
		return { success: true };
	});
}

export async function snoozeThread(input: {
	mailboxThreadId: string;
	activeMailboxId: string;
	snoozedUntil: string | null;
}) {
	return handleAction(async () => {
		const { mailboxThreadId, activeMailboxId, snoozedUntil } = input;

		const rls = await rlsClient();
		await rls(async (tx) => {
			return tx
				.update(mailboxThreads)
				.set({
					snoozedUntil: snoozedUntil ? new Date(snoozedUntil) : null,
					unsnoozedAt: snoozedUntil ? null : new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(mailboxThreads.threadId, mailboxThreadId),
						eq(mailboxThreads.mailboxId, activeMailboxId),
					),
				)
				.returning();
		});

		revalidatePath("/dashboard/mail");
		return { success: true };
	});
}

export const fetchIdentitySnoozedThreads = async (): Promise<{ threads: MailboxThreadEntity[] }> => {
	const rls = await rlsClient();
	const now = new Date();

	const rows = await rls((tx) =>

		tx
			.select({
				thread: mailboxThreads
			})
			.from(mailboxThreads)
			.where(
				and(
					isNotNull(mailboxThreads.snoozedUntil),
					gt(mailboxThreads.snoozedUntil, now),
				),
			)
			.orderBy(
				desc(mailboxThreads.snoozedUntil),
				desc(mailboxThreads.lastActivityAt),
			)
	)

	return {
		threads: rows.map((r) => r.thread),
	};
};


function subscriptionKeyFromHeadersJson(headersJson: any) {
	const list = headersJson?.list ?? null;
	const rawListId = String(headersJson?.["list-id"] ?? "").trim() || null;

	let unsubscribeHttpUrl: string | null = null;

	const fromList = list?.unsubscribe?.url || list?.unsubscribe?.href;
	if (typeof fromList === "string" && fromList) unsubscribeHttpUrl = fromList;

	const fromHeader = headersJson?.["list-unsubscribe"];
	if (!unsubscribeHttpUrl && typeof fromHeader === "string") {
		const parts = fromHeader
			.split(",")
			.map((s: string) => s.trim().replace(/^<|>$/g, ""));
		const http = parts.find((p: string) => /^https?:/i.test(p));
		if (http) unsubscribeHttpUrl = http;
	}

	if (rawListId) {
		const cleaned = rawListId
			.replace(/^<|>$/g, "")
			.replace(/\s+/g, "")
			.toLowerCase();
		return cleaned ? `list-id:${cleaned}` : null;
	}

	if (unsubscribeHttpUrl) {
		try {
			const u = new URL(unsubscribeHttpUrl);
			const p = (u.pathname || "/").replace(/\/+$/, "") || "/";
			return `${u.protocol}//${u.host.toLowerCase()}${p}`;
		} catch {
			return null;
		}
	}

	return null;
}

export async function fetchThreadMailSubscriptions(opts: {
	/** @deprecated Ignored: rows are read through RLS for the session's workspace. */
	ownerId?: string;
	messages: Array<{ id: string; headersJson: any }>;
}) {
	const keysByMessageId = new Map<string, string>();

	for (const m of opts.messages ?? []) {
		const key = subscriptionKeyFromHeadersJson(m.headersJson);
		if (key) keysByMessageId.set(m.id, key);
	}

	const uniqueKeys = Array.from(new Set(keysByMessageId.values()));
	if (!uniqueKeys.length) {
		return {
			byMessageId: new Map<string, MailSubscriptionEntity | null>(),
			keysByMessageId,
		};
	}

	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select()
			.from(mailSubscriptions)
			.where(inArray(mailSubscriptions.subscriptionKey, uniqueKeys)),
	);

	const byKey = new Map(rows.map((r) => [r.subscriptionKey, r]));
	const byMessageId = new Map<string, MailSubscriptionEntity | null>();

	for (const [messageId, key] of keysByMessageId.entries()) {
		byMessageId.set(messageId, byKey.get(key) ?? null);
	}

	return { byMessageId, keysByMessageId };
}

export type FetchThreadMailSubsResult = Awaited<
	ReturnType<typeof fetchThreadMailSubscriptions>
>;


export async function oneClickUnsubscribe(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData);
		const id = String(decodedForm.mailSubscriptionId ?? "");
		if (!id) return { success: false, error: "mailbox.subscriptionNotFound" };

		// RLS: only subscriptions of the caller's workspace.
		const rls = await rlsClient();
		const [sub] = await rls((tx) =>
			tx
				.select()
				.from(mailSubscriptions)
				.where(eq(mailSubscriptions.id, id))
				.limit(1),
		).catch(() => []);
		if (!sub?.unsubscribeHttpUrl) return { success: false, error: "mailbox.subscriptionNotFound" };

		// The URL comes from a received mail: no private/internal targets,
		// no credentials, no redirects (RFC 8058 one-click is a single POST).
		let status: number;
		try {
			status = await safeFormPost(
				sub.unsubscribeHttpUrl,
				"List-Unsubscribe=One-Click",
			);
		} catch (error) {
			console.warn("One-click unsubscribe failed", error);
			return { success: false, error: "Unsubscribe request failed." };
		}
		if (status < 200 || status >= 400) {
			return {
				success: false,
				error: `Unsubscribe failed: HTTP ${status}`,
			};
		}

		await rls((tx) =>
			tx
				.update(mailSubscriptions)
				.set({
					status: "unsubscribed",
					unsubscribedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(mailSubscriptions.id, sub.id)),
		);
		const pathname =
			typeof decodedForm.pathname === "string" && decodedForm.pathname.startsWith("/")
				? decodedForm.pathname
				: "/dashboard/mail";
		revalidatePath(pathname);
		return { success: true };
	});
}
