import { generateSnippet, upsertMailboxThreadItem } from "@common";
import {
	type ContactCreate,
	contacts,
	db,
	type MessageAttachmentCreate,
	MessageAttachmentInsertSchema,
	type MessageCreate,
	MessageInsertSchema,
	mailboxes,
	mailRules,
	mailSubscriptions,
	messageAttachments,
	messages,
	threads,
	webhooks,
} from "@db";
import { getPublicEnv, getServerEnv } from "@schema";
import slugify from "@sindresorhus/slugify";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { type Attachment, type ParsedMail, simpleParser } from "mailparser";
import { getRedis } from "../lib/get-redis";

const publicConfig = getPublicEnv();
const serverConfig = getServerEnv();
const supabase = createClient(
	publicConfig.API_URL,
	serverConfig.SERVICE_ROLE_KEY,
);

const SEARCH_BATCH_SIZE = 100;
const WEBHOOK_BATCH_SIZE = 100;
const RULES_BATCH_SIZE = 100;
const CALENDAR_BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 1000;

type SearchJob = {
	messageId: string;
	contactId: string | null;
	ownerId?: string;
};
type WebhookJob = { message: any; rawEmail: string };
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

/** Mailbox ids (of the given ones) whose identity has an enabled message.received webhook. */
async function mailboxesWithWebhooks(mailboxIds: string[]) {
	if (!mailboxIds.length) return new Set<string>();
	const rows = await db
		.selectDistinct({ id: mailboxes.id })
		.from(mailboxes)
		.innerJoin(
			webhooks,
			and(
				eq(webhooks.ownerId, mailboxes.ownerId),
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
				eq(mailRules.enabled, true),
			),
		)
		.where(inArray(mailboxes.id, mailboxIds));
	return new Set(rows.map((r) => r.id));
}

async function flushBatches() {
	if (
		!searchBuffer.length &&
		!webhookBuffer.length &&
		!icsBuffer.length &&
		!rulesBuffer.length
	)
		return;

	// Take the buffers synchronously: messages stored while the queue calls
	// below are awaited go into fresh buffers instead of being wiped by the
	// reset that used to happen after the await.
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

			// The buffer is shared by all owners: group contacts per owner (the
			// batch used to be filed under the first message's owner) and drop
			// missing / duplicate contact ids.
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
			// Webhook jobs carry the full raw email: only enqueue them for
			// mailboxes that actually have a matching webhook.
			const withHooks = await mailboxesWithWebhooks([
				...new Set(webhookJobs.map((job) => String(job.message.mailboxId))),
			]);
			const jobs = webhookJobs
				.filter((job) => withHooks.has(String(job.message.mailboxId)))
				.map((job) => ({
					name: "webhook:message.received",
					data: {
						message: job.message,
						rawEmail: job.rawEmail,
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
	parsed: ParsedMail & { ownerId: string },
) {
	const { ownerId } = parsed;
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

export async function upsertContactsFromMessage(
	ownerId: string,
	parsed: ParsedMail,
) {
	const addr = getFromAddress(parsed);
	if (!addr) return null;

	let contactId: string | null = null;
	const email = addr.email;
	const displayName = addr.name;

	const existing = await db
		.select()
		.from(contacts)
		.where(
			and(
				eq(contacts.ownerId, ownerId),
				sql`${contacts.emails}::jsonb @> ${JSON.stringify([
					{ address: email },
				])}::jsonb`,
			),
		)
		.limit(1);

	if (existing.length === 0) {
		let firstName = "Unknown";
		let lastName: string | null = null;

		if (displayName) {
			const parts = displayName.split(" ").filter(Boolean);
			firstName = parts[0] || "Unknown";
			lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
		}

		const newContact = {
			ownerId,
			firstName,
			lastName,
			emails: [{ address: email }],
			slug: slugify(displayName || email),
			profilePictureXs: null,
		};

		const inserted = await db
			.insert(contacts)
			.values(newContact as ContactCreate)
			.onConflictDoNothing()
			.returning();

		if (inserted.length > 0) {
			contactId = inserted[0].id;
			return contactId;
		}

		const [existingAfter] = await db
			.select()
			.from(contacts)
			.where(
				and(
					eq(contacts.ownerId, ownerId),
					sql`${contacts.emails}::jsonb @> ${JSON.stringify([
						{ address: email },
					])}::jsonb`,
				),
			)
			.limit(1);

		contactId = existingAfter?.id ?? null;
		return contactId;
	}

	const contact = existing[0];

	const hasName = contact.firstName || contact.lastName;
	if (hasName || !displayName) {
		return contact.id;
	}

	const parts = displayName.split(" ").filter(Boolean);
	const firstName = parts[0] || contact.firstName || "Unknown";
	const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;

	await db
		.update(contacts)
		.set({
			firstName,
			lastName,
		})
		.where(eq(contacts.id, contact.id));

	contactId = contact.id;
	return contactId;
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
 * their rows with one statement instead of one INSERT per attachment.
 */
async function storeAttachments(opts: {
	attachments: Attachment[];
	ownerId: string;
	mailboxId: string;
	messageId: string;
	collectIcs: boolean;
}) {
	const { attachments, ownerId, mailboxId, messageId, collectIcs } = opts;
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

			const { data, error } = await supabase.storage
				.from(bucket)
				.upload(objectPath, attachment.content, {
					contentType: attachment.contentType || "application/octet-stream",
					upsert: false,
					cacheControl: "31536000",
				});
			if (error) {
				console.warn(
					"[parseAndStoreEmail] Attachment upload failed; skipping attachment",
					{
						messageId,
						filename: attachment.filename,
						path: objectPath,
						message: error.message,
					},
				);
				continue;
			}
			uploaded[index] = { attachment, path: data?.path };
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
	}
	if (icsBuffer.length >= CALENDAR_BATCH_SIZE) {
		await flushBatches();
	} else if (icsBuffer.length) {
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
	const { ownerId, mailboxId, rawStorageKey } = opts;
	const mode = opts.mode ?? "live";

	// Keep "cid:" references instead of inlining images as base64 data URIs:
	// inline images are stored as attachments and resolved by the web app,
	// which keeps the stored HTML (and every thread payload) small.
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

	// Already stored in this mailbox (re-sync / duplicate delivery): stop
	// before uploading the EML again and before creating a thread that the
	// conflicting insert below would leave orphaned.
	const [alreadyStored] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(eq(messages.mailboxId, mailboxId), eq(messages.messageId, messageId)),
		)
		.limit(1);
	if (alreadyStored) return null;

	const encoder = new TextEncoder();
	const emailBuffer = encoder.encode(rawEmail);
	let storedRawStorageKey: string | null = opts.rawStorageKey;

	const { error: rawUploadError } = await supabase.storage
		.from("attachments")
		.upload(opts.rawStorageKey, emailBuffer, {
			contentType: "message/rfc822",
			upsert: true,
		});
	if (rawUploadError) {
		storedRawStorageKey = null;
		console.warn(
			"[parseAndStoreEmail] Raw EML upload failed; continuing without raw source",
			{
				mailboxId,
				storageKey: opts.rawStorageKey,
				message: rawUploadError.message,
			},
		);
	}

	const thread = await createOrInitializeThread({
		...parsed,
		ownerId,
		// mailboxId,
	});

	const decoratedParsed = {
		...parsed,
		mailboxId,
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

	const messagePayload = MessageInsertSchema.parse(decoratedParsed);
	const [message] = await db
		.insert(messages)
		.values(messagePayload as MessageCreate)
		.onConflictDoNothing({
			target: [messages.mailboxId, messages.messageId],
		})
		.returning();

	if (!message) return null;
	await ingestMailSubscriptionFromMessage({
		ownerId,
		parsed,
		headersJson: (decoratedParsed as any).headersJson,
	});

	const contactId = await upsertContactsFromMessage(ownerId, parsed);
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
		mailboxId,
		messageId: message.id,
		collectIcs: mode === "live",
	});

	searchBuffer.push({
		messageId: message.id,
		contactId: contactId ? String(contactId) : null,
		ownerId,
	});
	if (searchBuffer.length >= SEARCH_BATCH_SIZE) {
		await flushBatches();
	} else {
		scheduleFlush();
	}

	if (mode === "live") {
		webhookBuffer.push({ message, rawEmail });
		rulesBuffer.push({ messageId: message.id, mailboxId: message.mailboxId });
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
	parsed: ParsedMail;
	headersJson: Record<string, any>;
}) {
	const { ownerId, parsed, headersJson } = opts;

	const headers = parsed.headers as Map<string, any>;
	const list =
		(headers.get("list") as any) ?? (headersJson as any)?.list ?? null;

	const rawListId =
		String(
			headers.get("list-id") ?? (headersJson as any)?.["list-id"] ?? "",
		).trim() || null;

	const unsubscribeUrl =
		(list?.unsubscribe?.url as string | undefined) ||
		(list?.unsubscribe?.href as string | undefined) ||
		null;

	const unsubscribePost =
		String(list?.["unsubscribe-post"]?.name ?? "").toLowerCase() || null;

	let unsubscribeMailto: string | null = null;
	const rawListUnsub =
		headers.get("list-unsubscribe") ??
		(headersJson as any)?.["list-unsubscribe"];
	if (
		typeof rawListUnsub === "string" &&
		rawListUnsub.toLowerCase().includes("mailto:")
	) {
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
			subscriptionKey,
			listId: rawListId,
			unsubscribeHttpUrl: unsubscribeUrl,
			unsubscribeMailto,
			oneClick,
			lastSeenAt: new Date(),
		} as any)
		.onConflictDoUpdate({
			target: [mailSubscriptions.ownerId, mailSubscriptions.subscriptionKey],
			set: {
				listId: rawListId,
				unsubscribeHttpUrl: unsubscribeUrl,
				unsubscribeMailto,
				oneClick,
				lastSeenAt: new Date(),
			} as any,
		});
}
