import { simpleParser, ParsedMail, Attachment } from "mailparser";
import {
	db,
	messages,
	messageAttachments,
	threads,
	MessageInsertSchema,
	MessageCreate,
	MessageAttachmentCreate,
	MessageAttachmentInsertSchema,
	mailSubscriptions,
	workspaces,
	mailboxes,
	mailRules,
	webhooks,
} from "@db";
import { generateSnippet, upsertMailboxThreadItem } from "@common";
import { randomUUID } from "crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getRedis } from "../lib/get-redis";
import {s3} from "../lib/create-s3-client";
import {PutObjectCommand} from "@aws-sdk/client-s3";
import {upsertWorkspaceSharedContactFromMessage} from "../lib/message-parser-contacts";

const SEARCH_BATCH_SIZE = 100;
const WEBHOOK_BATCH_SIZE = 100;
const RULES_BATCH_SIZE = 100;
const CALENDAR_BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 1000;

type SearchJob = {
	messageId: string;
	contactId: string | null;
	/** Owner of the contact row (the DAV job looks the contact up by owner). */
	ownerId?: string;
};
type WebhookJob = {
	messageId: string;
	mailboxId: string;
	rawStorageKey: string | null;
};
type ICSJob = {
	messageId: string;
	messageAttachmentId: string;
	mailboxId: string;
};
type RulesJob = {
	messageId: string;
	mailboxId: string;
};

let searchBuffer: SearchJob[] = [];
let webhookBuffer: WebhookJob[] = [];
let icsBuffer: ICSJob[] = [];
let rulesBuffer: RulesJob[] = [];
let flushTimer: any = null;

/**
 * Mailbox ids (of the given ones) whose identity has an enabled
 * message.received webhook in the mailbox's workspace.
 */
async function mailboxesWithWebhooks(mailboxIds: string[]) {
	if (!mailboxIds.length) return new Set<string>();
	const rows = await db
		.selectDistinct({ id: mailboxes.id })
		.from(mailboxes)
		.innerJoin(
			webhooks,
			and(
				eq(webhooks.workspaceId, mailboxes.workspaceId),
				or(
					eq(webhooks.identityId, mailboxes.identityId),
					isNull(webhooks.identityId),
				),
			),
		)
		.where(
			and(
				inArray(mailboxes.id, mailboxIds),
				eq(webhooks.enabled, true),
				sql`${webhooks.events} @> '{message.received}'::webhook_list[]`,
			),
		);
	return new Set(rows.map((r) => r.id));
}

/** Mailbox ids (of the given ones) whose identity has at least one enabled rule. */
async function mailboxesWithRules(mailboxIds: string[]) {
	if (!mailboxIds.length) return new Set<string>();
	const rows = await db
		.selectDistinct({ id: mailboxes.id })
		.from(mailboxes)
		.innerJoin(
			mailRules,
			and(
				eq(mailRules.identityId, mailboxes.identityId),
				eq(mailRules.workspaceId, mailboxes.workspaceId),
				eq(mailRules.enabled, true),
			),
		)
		.where(inArray(mailboxes.id, mailboxIds));
	return new Set(rows.map((r) => r.id));
}

async function flushBatches() {
	if (!searchBuffer.length && !webhookBuffer.length && !icsBuffer.length && !rulesBuffer.length)
		return;

	// Take the buffers synchronously: messages stored while the queue calls
	// below are awaited go into fresh buffers instead of being wiped by a
	// reset after the await.
	const searchJobs = searchBuffer;
	const icsJobs = icsBuffer;
	const webhookJobs = webhookBuffer;
	const rulesJobs = rulesBuffer;
	searchBuffer = [];
	icsBuffer = [];
	webhookBuffer = [];
	rulesBuffer = [];

	try {
		const { searchIngestQueue, commonWorkerQueue, davWorkerQueue } =
			await getRedis();

		if (searchJobs.length) {
			const messageIds = searchJobs.map((job) => job.messageId);

			await searchIngestQueue.add(
				"addBatch",
				{ messageIds },
				{ removeOnComplete: true },
			);

			// The buffer is shared by all owners and workspaces: group contacts
			// per contact owner (the batch used to be filed under the first
			// message's owner) and drop missing / duplicate contact ids.
			const contactsByOwner = new Map<string, Set<string>>();
			for (const job of searchJobs) {
				if (!job.contactId || !job.ownerId) continue;
				const set = contactsByOwner.get(job.ownerId) ?? new Set<string>();
				set.add(job.contactId);
				contactsByOwner.set(job.ownerId, set);
			}
			for (const [ownerId, contactIds] of contactsByOwner) {
				await davWorkerQueue.add(
					"dav:create-contacts-batch",
					{ contactIds: [...contactIds], ownerId },
					{ removeOnComplete: true, removeOnFail: true },
				);
			}
		}

		if (icsJobs.length) {
			await davWorkerQueue.add(
				"dav:calendar:itip-ingest-batch",
				{
					items: icsJobs.map((job) => ({
						messageId: job.messageId,
						messageAttachmentId: job.messageAttachmentId,
						mailboxId: job.mailboxId,
					})),
				},
				{
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
		}

		if (webhookJobs.length) {
			// Webhook jobs download the raw email: only enqueue them for
			// mailboxes that actually have a matching webhook.
			const withHooks = await mailboxesWithWebhooks([
				...new Set(webhookJobs.map((job) => job.mailboxId)),
			]);
			const jobs = webhookJobs
				.filter((job) => withHooks.has(job.mailboxId))
				.map((job) => ({
					name: "webhook:message.received",
					data: {
						messageId: job.messageId,
						rawStorageKey: job.rawStorageKey,
					},
					opts: {
						removeOnComplete: true,
						removeOnFail: true,
					},
				}));

			if (jobs.length) await commonWorkerQueue.addBulk(jobs);
		}

		if (rulesJobs.length) {
			const withRules = await mailboxesWithRules([
				...new Set(rulesJobs.map((job) => job.mailboxId)),
			]);
			const jobs = rulesJobs
				.filter((job) => withRules.has(job.mailboxId))
				.map((job) => ({
					name: "rules:processor",
					data: {
						messageId: job.messageId,
					},
				}));
			if (jobs.length) await commonWorkerQueue.addBulk(jobs);
		}
	} catch (err: any) {
		console.error(
			"[parseAndStoreEmail] Error flushing batches:",
			err?.message ?? err,
		);
	}
}

function scheduleFlush() {
	if (flushTimer) return;
	flushTimer = setTimeout(async () => {
		flushTimer = null;
		await flushBatches();
	}, FLUSH_INTERVAL_MS);
}

function generateFileName(att: Attachment) {
	const ext =
		att.filename?.split(".").pop()?.toLowerCase() ||
		att.contentType?.split("/")[1]?.split("+")[0] ||
		"bin";
	return `${randomUUID()}.${ext}`;
}

export async function createOrInitializeThread(
	parsed: ParsedMail & { ownerId: string, workspaceId: string },
) {
	const { ownerId, workspaceId } = parsed;
	const inReplyTo = parsed.inReplyTo?.trim() || null;
	const refs = Array.isArray(parsed.references)
		? parsed.references
		: parsed.references
			? [parsed.references]
			: [];
	const candidates = Array.from(
		new Set([inReplyTo, ...refs].filter(Boolean).map((s) => String(s))),
	);

	return db.transaction(async (tx) => {
		let existingThread = null;

		if (candidates.length > 0) {
			const parentMsgs = await tx
				.select({
					id: messages.id,
					threadId: messages.threadId,
					messageId: messages.messageId,
					date: messages.date,
				})
				.from(messages)
				.where(
					and(
						eq(messages.ownerId, ownerId),
						inArray(messages.messageId, candidates),
					),
				)
				.orderBy(desc(messages.date ?? sql`now()`));

			if (parentMsgs.length) {
				const chosen = inReplyTo
					? parentMsgs.find((m) => m.messageId === inReplyTo)
					: parentMsgs[0];

				if (chosen?.threadId) {
					const [t] = await tx
						.select()
						.from(threads)
						.where(eq(threads.id, chosen.threadId));
					if (t) existingThread = t;
				}
			}
		}

		if (existingThread) return existingThread;

		const [newThread] = await tx
			.insert(threads)
			.values({
				ownerId,
				workspaceId,
				lastMessageDate: parsed.date ?? new Date(),
			})
			.returning();

		return newThread;
	});
}

function getFromAddress(parsed: ParsedMail) {
	const from = parsed.from?.value?.[0];
	if (!from?.address) return null;
	return {
		email: from.address.trim().toLowerCase(),
		name: (from.name || "").trim() || null,
	};
}


function isIcsAttachment(att: Attachment) {
	const ct = (att.contentType || "").toLowerCase();
	const name = (att.filename || "").toLowerCase();

	return (
		ct.startsWith("text/calendar") ||
		ct === "application/ics" ||
		name.endsWith(".ics")
	);
}

const ATTACHMENT_UPLOAD_CONCURRENCY = 4;

/**
 * Uploads the attachments of a stored message (a few in parallel) and inserts
 * their rows with one statement instead of one INSERT per attachment. A failed
 * upload skips that attachment instead of aborting the (IMAP) sync.
 */
async function storeAttachments(opts: {
	attachments: Attachment[];
	ownerId: string;
	workspaceId: string;
	mailboxId: string;
	messageId: string;
	collectIcs: boolean;
}) {
	const { attachments, ownerId, workspaceId, mailboxId, messageId, collectIcs } =
		opts;
	if (!attachments.length) return;

	const bucket = "attachments";
	const uploaded: Array<{ attachment: Attachment; path: string } | null> =
		new Array(attachments.length).fill(null);

	let next = 0;
	const uploadWorker = async () => {
		while (next < attachments.length) {
			const index = next++;
			const attachment = attachments[index];
			const fileName = generateFileName(attachment);
			const objectPath = `private/${ownerId}/${messageId}/${fileName}`;

			try {
				await s3.send(
					new PutObjectCommand({
						Bucket: process.env.S3_BUCKET!,
						Key: objectPath,
						Body: attachment.content,
						ContentType:
							attachment.contentType || "application/octet-stream",
						CacheControl: "public, max-age=31536000",
					}),
				);
				uploaded[index] = { attachment, path: objectPath };
			} catch (err: any) {
				console.warn(
					"[parseAndStoreEmail] Attachment upload failed; skipping attachment",
					{
						messageId,
						filename: attachment.filename,
						path: objectPath,
						message: err?.message ?? String(err),
					},
				);
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(ATTACHMENT_UPLOAD_CONCURRENCY, attachments.length) },
			uploadWorker,
		),
	);

	const stored = uploaded.filter(
		(u): u is { attachment: Attachment; path: string } => u !== null,
	);
	if (!stored.length) return;

	const rows = stored.map(({ attachment, path }) =>
		MessageAttachmentInsertSchema.parse({
			ownerId,
			workspaceId,
			messageId,
			bucketId: bucket,
			path,
			filenameOriginal: attachment.filename || null,
			contentType: attachment.contentType || "application/octet-stream",
			sizeBytes: Number(attachment.size ?? attachment.content?.length ?? 0),
			checksum: attachment.checksum || null,
			cid: attachment.cid || null,
			isInline:
				attachment.contentDisposition === "inline" || !!attachment.cid || false,
			disposition: attachment.contentDisposition || "attachment",
		} as MessageAttachmentCreate),
	);

	const inserted = await db
		.insert(messageAttachments)
		.values(rows)
		.returning({ id: messageAttachments.id, path: messageAttachments.path });

	if (!collectIcs) return;

	const idByPath = new Map(inserted.map((r) => [r.path, r.id]));
	const seenIcsChecksums = new Set<string>();
	let queued = false;
	for (const { attachment, path } of stored) {
		if (!isIcsAttachment(attachment)) continue;
		const attachmentId = idByPath.get(path);
		if (!attachmentId) continue;
		const key =
			attachment.checksum || `${attachment.size}:${attachment.contentType}`;
		if (seenIcsChecksums.has(key)) continue;
		seenIcsChecksums.add(key);
		icsBuffer.push({
			messageId,
			messageAttachmentId: attachmentId,
			mailboxId,
		});
		queued = true;
	}
	if (!queued) return;
	if (icsBuffer.length >= CALENDAR_BATCH_SIZE) {
		await flushBatches();
	} else {
		scheduleFlush();
	}
}

/**
 * Parse raw email, create thread, insert message + attachments.
 */


export async function parseAndStoreEmail(
	rawEmail: string,
	opts: {
		ownerId: string;
		workspaceId: string;
		mailboxId: string;
		rawStorageKey: string;
		emlKey: string;
		metaData?: Record<string, any>;
		seen?: boolean;
		answered?: boolean;
		flagged?: boolean;
		mode?: "live" | "backfill";
		/** Already parsed message (must be parsed with `keepCidLinks: true`). */
		parsed?: ParsedMail;
	},
) {
	const { ownerId, workspaceId, mailboxId, rawStorageKey } = opts;

	const mode = opts.mode ?? "live";

	// Keep "cid:" references instead of inlining images as base64 data URIs:
	// inline images are stored as attachments and resolved by the web app,
	// which keeps the stored HTML (search index, thread payloads) small.
	const parsed =
		opts.parsed ?? (await simpleParser(rawEmail, { keepCidLinks: true }));
	const headers = parsed.headers as Map<string, any>;

	const messageId =
		parsed.messageId || String(headers.get("message-id") || "").trim();

	if (!messageId) {
		console.warn(
			`[parseAndStoreEmail] Skipping message with no Message-ID (mailboxId=${mailboxId}, storageKey=${rawStorageKey})`,
		);
		return null;
	}

	/**
	 * Important for IMAP replay / UIDVALIDITY recovery:
	 *
	 * If this message already exists in this mailbox, do not recreate
	 * the message, attachments, thread, contacts, rules, webhooks, etc.
	 *
	 * Instead, refresh the IMAP metadata and flags because the UID,
	 * mailbox path or flags may have changed on the server.
	 */
	const [existingMessage] = await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				eq(messages.messageId, messageId),
			),
		)
		.limit(1);

	if (existingMessage) {
		const existingMeta =
			(existingMessage.metaData as Record<string, any>) ?? {};

		const incomingMeta = opts.metaData ?? {};

		const nextMeta = {
			...existingMeta,
			...incomingMeta,
			imap: {
				...(existingMeta.imap ?? {}),
				...(incomingMeta.imap ?? {}),
			},
		};

		await db
			.update(messages)
			.set({
				metaData: nextMeta,
				seen:
					typeof opts.seen === "boolean"
						? opts.seen
						: existingMessage.seen,
				answered:
					typeof opts.answered === "boolean"
						? opts.answered
						: existingMessage.answered,
				flagged:
					typeof opts.flagged === "boolean"
						? opts.flagged
						: existingMessage.flagged,
				updatedAt: new Date(),
			})
			.where(eq(messages.id, existingMessage.id));

		return existingMessage;
	}

	const encoder = new TextEncoder();
	const emailBuffer = encoder.encode(rawEmail);
	const sizeBytes = emailBuffer.byteLength;

	// A failed raw EML upload must not abort the (IMAP) sync: store the
	// message without its raw source instead.
	let storedRawStorageKey: string | null = rawStorageKey;
	try {
		await s3.send(
			new PutObjectCommand({
				Bucket: process.env.S3_BUCKET!,
				Key: rawStorageKey,
				Body: emailBuffer,
				ContentType: "message/rfc822",
			}),
		);
	} catch (err: any) {
		storedRawStorageKey = null;
		console.warn(
			"[parseAndStoreEmail] Raw EML upload failed; continuing without raw source",
			{
				mailboxId,
				storageKey: rawStorageKey,
				message: err?.message ?? String(err),
			},
		);
	}

	const thread = await createOrInitializeThread({
		...parsed,
		ownerId,
		workspaceId,
	});

	const decoratedParsed = {
		...parsed,
		mailboxId,
		workspaceId,
		threadId: thread.id,
		ownerId,
		headersJson: Object.fromEntries(parsed.headers as Map<string, any>),
		hasAttachments: (parsed.attachments?.length ?? 0) > 0,
		rawStorageKey: storedRawStorageKey,
		references: Array.isArray(parsed.references)
			? parsed.references
			: parsed.references
				? [parsed.references]
				: null,
		seen: false,
		answered: false,
		flagged: false,
		draft: false,
		html: parsed.html || "",
		sizeBytes,
		snippet: generateSnippet(parsed.text || parsed.html || ""),
	} as MessageCreate | ParsedMail;

	if (opts.metaData) {
		(decoratedParsed as any).metaData = opts.metaData;
	}

	if (typeof opts.seen === "boolean") {
		(decoratedParsed as any).seen = opts.seen;
	}

	if (typeof opts.answered === "boolean") {
		(decoratedParsed as any).answered = opts.answered;
	}

	if (typeof opts.flagged === "boolean") {
		(decoratedParsed as any).flagged = opts.flagged;
	}

	const messagePayload = sanitizePostgresValue(
		MessageInsertSchema.parse(decoratedParsed),
	);

	const [message] = await db
		.insert(messages)
		.values(messagePayload as MessageCreate)
		.onConflictDoNothing({
			target: [messages.mailboxId, messages.messageId],
		})
		.returning();

	/**
	 * Another worker/replay may have inserted the message between our
	 * initial lookup and this insert. In that case, just stop here.
	 */
	if (!message) {
		const [existingThreadMessage] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.threadId, thread.id))
			.limit(1);

		if (!existingThreadMessage) {
			await db
				.delete(threads)
				.where(eq(threads.id, thread.id));
		}

		return null;
	}

	await db
		.update(workspaces)
		.set({
			storageBytesUsed: sql`${workspaces.storageBytesUsed} + ${sizeBytes}`,
		})
		.where(eq(workspaces.id, workspaceId));

	await ingestMailSubscriptionFromMessage({
		ownerId,
		workspaceId,
		parsed,
		headersJson: (decoratedParsed as any).headersJson,
	});

	const contactRes = await upsertWorkspaceSharedContactFromMessage({
		parsed,
		mailboxId,
		fallbackOwnerId: ownerId,
	});

	const contactId = contactRes?.contactIdForMessage ?? null;
	const contactOwnerId =
		contactRes?.insertedOrFound.find((r) => r.contactId === contactId)
			?.ownerId ?? ownerId;

	await upsertMailboxThreadItem(message.id);

	// Single conditional UPDATE instead of SELECT + UPDATE.
	const msgDate = message.createdAt ?? new Date();
	await db
		.update(threads)
		.set({ lastMessageDate: msgDate })
		.where(
			and(
				eq(threads.id, thread.id),
				or(
					isNull(threads.lastMessageDate),
					lt(threads.lastMessageDate, msgDate),
				),
			),
		);

	await storeAttachments({
		attachments: parsed.attachments ?? [],
		ownerId,
		workspaceId,
		mailboxId,
		messageId: message.id,
		collectIcs: mode === "live",
	});

	searchBuffer.push({
		messageId: message.id,
		contactId: contactId
			? String(contactId)
			: null,
		ownerId: contactOwnerId,
	});

	if (searchBuffer.length >= SEARCH_BATCH_SIZE) {
		await flushBatches();
	} else {
		scheduleFlush();
	}

	if (mode === "live") {
		webhookBuffer.push({
			messageId: message.id,
			mailboxId,
			rawStorageKey: storedRawStorageKey,
		});

		rulesBuffer.push({
			messageId: message.id,
			mailboxId,
		});

		if (
			webhookBuffer.length >= WEBHOOK_BATCH_SIZE ||
			rulesBuffer.length >= RULES_BATCH_SIZE
		) {
			await flushBatches();
		} else {
			scheduleFlush();
		}
	}

	return message;
}


async function ingestMailSubscriptionFromMessage(opts: {
	ownerId: string;
	workspaceId: string;
	parsed: ParsedMail;
	headersJson: Record<string, any>;
}) {
	const { ownerId, workspaceId, parsed, headersJson } = opts;

	const headers = parsed.headers as Map<string, any>;
	const list =
		(headers.get("list") as any) ??
		(headersJson as any)?.list ??
		null;

	const rawListId =
		String(headers.get("list-id") ?? (headersJson as any)?.["list-id"] ?? "")
			.trim() || null;

	const unsubscribeUrl =
		(list?.unsubscribe?.url as string | undefined) ||
		(list?.unsubscribe?.href as string | undefined) ||
		null;

	const unsubscribePost =
		String(list?.["unsubscribe-post"]?.name ?? "").toLowerCase() || null;

	let unsubscribeMailto: string | null = null;
	const rawListUnsub = headers.get("list-unsubscribe") ?? (headersJson as any)?.["list-unsubscribe"];
	if (typeof rawListUnsub === "string" && rawListUnsub.toLowerCase().includes("mailto:")) {
		const m = rawListUnsub.match(/mailto:([^>\s,]+)/i);
		unsubscribeMailto = (m?.[1] ?? "").trim().toLowerCase() || null;
	}

	if (!rawListId && !unsubscribeUrl && !unsubscribeMailto) return;

	let subscriptionKey: string | null = null;

	if (rawListId) {
		const cleaned = rawListId
			.replace(/^<|>$/g, "")
			.replace(/\s+/g, "")
			.toLowerCase();
		subscriptionKey = cleaned ? `list-id:${cleaned}` : null;
	} else if (unsubscribeUrl) {
		try {
			const u = new URL(unsubscribeUrl);
			const p = (u.pathname || "/").replace(/\/+$/, "") || "/";
			subscriptionKey = `${u.protocol}//${u.host}${p}`;
		} catch {
			subscriptionKey = null;
		}
	} else if (unsubscribeMailto) {
		subscriptionKey = `mailto:${unsubscribeMailto}`;
	} else {
		const from = getFromAddress(parsed);
		if (from?.email?.includes("@")) {
			subscriptionKey = `from-domain:${from.email.split("@")[1]}`;
		}
	}

	if (!subscriptionKey) return;

	const oneClick = unsubscribePost?.includes("one-click") ?? false;
	await db
		.insert(mailSubscriptions)
		.values({
			ownerId,
			workspaceId,
			subscriptionKey,
			listId: rawListId,
			unsubscribeHttpUrl: unsubscribeUrl,
			unsubscribeMailto,
			oneClick,
			lastSeenAt: new Date(),
		} as any)
		.onConflictDoUpdate({
			target: [
				mailSubscriptions.workspaceId,
				mailSubscriptions.subscriptionKey,
			],
			set: {
				listId: rawListId,
				unsubscribeHttpUrl: unsubscribeUrl,
				unsubscribeMailto,
				oneClick,
				lastSeenAt: new Date(),
			},
		});

}

function sanitizePostgresValue<T>(value: T): T {
	if (typeof value === "string") {
		return value.replace(/\u0000/g, "") as T;
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizePostgresValue(item)) as T;
	}

	if (
		value &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, val]) => [
				key,
				sanitizePostgresValue(val),
			]),
		) as T;
	}

	return value;
}
