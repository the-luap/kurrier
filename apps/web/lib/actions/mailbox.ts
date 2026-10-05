"use server";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PAGE_SIZE } from "@common/mail-client";
import {
	DraftMessageInsertSchema,
	db,
	draftMessages,
	identities,
	mailboxes,
	mailboxSync,
	mailboxThreads,
	mailSubscriptions,
	messageAttachments,
	messages,
	threads,
	userAiSettings,
} from "@db";
import {
	type FormState,
	getServerEnv,
	handleAction,
	type SearchThreadsResponse,
} from "@schema";
import slugify from "@sindresorhus/slugify";
import dayjs from "dayjs";
import { decode } from "decode-formdata";
import {
	and,
	asc,
	count,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cache } from "react";
import Typesense, { type Client } from "typesense";
import { isSignedIn } from "@/lib/actions/auth";
import { rlsClient } from "@/lib/actions/clients";
import {
	addJobAndWait,
	getQueue,
	getSmtpQueue,
	RETRY_JOB_OPTS,
} from "@/lib/actions/get-redis";
import {
	aiProviderLabel,
	getAiDefaults,
	normalizeAiBaseUrl,
	runAiPrompt,
	toAiProvider,
} from "@/lib/ai-endpoint";
import {
	enqueueSearchRefresh,
	enqueueThreadSmtpJobs,
	toIdList,
} from "@/lib/mail-jobs";
import { invalidateServerCache, withServerCache } from "@/lib/server-cache";
import { toArray } from "@/lib/utils";

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

export const fetchMailbox = cache(
	async (identityPublicId: string, mailboxSlug = "inbox") => {
		const rls = await rlsClient();
		// One transaction instead of five: every rls() call is its own
		// BEGIN/set_config/COMMIT round trip.
		return rls(async (tx) => {
			const [identity] = await tx
				.select()
				.from(identities)

				.where(eq(identities.publicId, identityPublicId));

			const mailboxList = identity
				? await tx
						.select()
						.from(mailboxes)
						.where(eq(mailboxes.identityId, identity.id))
				: [];
			const activeMailbox = mailboxList.find((m) => m.slug === mailboxSlug);

			const [messagesCount] = activeMailbox?.id
				? await tx
						.select({ count: count() })
						.from(mailboxThreads)
						.where(eq(mailboxThreads.mailboxId, activeMailbox.id))
				: [{ count: 0 }];

			const [sync] = activeMailbox
				? await tx
						.select()
						.from(mailboxSync)
						.where(eq(mailboxSync.mailboxId, activeMailbox.id))
				: [null];

			return {
				activeMailbox,
				mailboxList,
				identity,
				count: Number(messagesCount?.count ?? 0),
				mailboxSync: sync,
			};
		});
	},
);

const fetchIdentityMailboxListUncached = async () => {
	const rls = await rlsClient();
	// One transaction for the list and the unread counts.
	const { rows, unreadAgg } = await rls(async (tx) => {
		const rows = await tx
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
			);

		const mailboxIds = rows.flatMap((r) => (r.mailbox ? [r.mailbox.id] : []));
		const unreadAgg = mailboxIds.length
			? await tx
					.select({
						mailboxId: mailboxThreads.mailboxId,
						unreadThreads: sql<number>`
        count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)
      `.as("unread_threads"),
						unreadTotal: sql<number>`
        coalesce(sum(${mailboxThreads.unreadCount}), 0)
      `.as("unread_total"),
					})
					.from(mailboxThreads)
					.where(inArray(mailboxThreads.mailboxId, mailboxIds))
					.groupBy(mailboxThreads.mailboxId)
			: [];
		return { rows, unreadAgg };
	});

	const byIdentity = rows.reduce(
		(acc, r) => {
			const id = r.identity.id;
			if (!acc[id])
				acc[id] = {
					identity: r.identity,
					mailboxes: [] as (typeof mailboxes.$inferSelect)[],
				};
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
	const aggByMailbox = new Map<
		string,
		{ unreadThreads: number; unreadTotal: number }
	>(
		unreadAgg.map((a) => [
			a.mailboxId,
			{
				unreadThreads: Number(a.unreadThreads ?? 0),
				unreadTotal: Number(a.unreadTotal ?? 0),
			},
		]),
	);

	return Object.values(byIdentity).map((entry) => ({
		...entry,
		mailboxes: entry.mailboxes.map((mailbox) => ({
			...mailbox,
			unreadCount: aggByMailbox.get(mailbox.id)?.unreadTotal ?? 0,
			unreadThreads: aggByMailbox.get(mailbox.id)?.unreadThreads ?? 0,
		})),
	}));
};

export const fetchIdentityMailboxList = cache(async () => {
	const user = await isSignedIn();
	if (!user?.id) return fetchIdentityMailboxListUncached();

	return withServerCache(
		user.id,
		`mailbox-list:${user.id}`,
		15,
		fetchIdentityMailboxListUncached,
	);
});

export type FetchIdentityMailboxListResult = Awaited<
	ReturnType<typeof fetchIdentityMailboxList>
>;

const fetchMailboxOverviewUncached = async () => {
	const identityMailboxList = await fetchIdentityMailboxList();
	const inboxMailboxIds = identityMailboxList.flatMap((entry) =>
		entry.mailboxes
			.filter((mailbox) => mailbox.kind === "inbox")
			.map((mailbox) => mailbox.id),
	);

	if (inboxMailboxIds.length === 0) {
		return identityMailboxList.map((entry) => ({
			...entry,
			mailboxes: [],
		}));
	}

	const rls = await rlsClient();
	const now = new Date();
	// Top 3 unread threads per inbox plus the unread thread count, both with
	// the same filter (snoozed threads excluded), so the badge and the list
	// agree and one busy inbox can't starve the others.
	const rankedRows = await rls((tx) => {
		const ranked = tx.$with("ranked").as(
			tx
				.select({
					...getTableColumns(mailboxThreads),
					rank: sql<number>`row_number() over (partition by ${mailboxThreads.mailboxId} order by ${mailboxThreads.lastActivityAt} desc)`.as(
						"rank",
					),
					unreadThreadsInMailbox:
						sql<number>`count(*) over (partition by ${mailboxThreads.mailboxId})`.as(
							"unread_threads_in_mailbox",
						),
					unreadMessagesInMailbox:
						sql<number>`sum(${mailboxThreads.unreadCount}) over (partition by ${mailboxThreads.mailboxId})`.as(
							"unread_messages_in_mailbox",
						),
				})
				.from(mailboxThreads)
				.where(
					and(
						inArray(mailboxThreads.mailboxId, inboxMailboxIds),
						gt(mailboxThreads.unreadCount, 0),
						or(
							isNull(mailboxThreads.snoozedUntil),
							lte(mailboxThreads.snoozedUntil, now),
						),
					),
				),
		);
		return tx
			.with(ranked)
			.select()
			.from(ranked)
			.where(lte(ranked.rank, 3))
			.orderBy(desc(ranked.lastActivityAt));
	});

	const recentByMailbox = new Map<
		string,
		(typeof mailboxThreads.$inferSelect)[]
	>();
	const unreadByMailbox = new Map<
		string,
		{ unreadThreads: number; unreadCount: number }
	>();
	for (const {
		rank: _rank,
		unreadThreadsInMailbox,
		unreadMessagesInMailbox,
		...thread
	} of rankedRows) {
		const list = recentByMailbox.get(thread.mailboxId) ?? [];
		list.push(thread);
		recentByMailbox.set(thread.mailboxId, list);
		unreadByMailbox.set(thread.mailboxId, {
			unreadThreads: Number(unreadThreadsInMailbox),
			unreadCount: Number(unreadMessagesInMailbox),
		});
	}

	return identityMailboxList.map((entry) => ({
		...entry,
		mailboxes: entry.mailboxes.map((mailbox) => ({
			...mailbox,
			totalThreads: 0,
			...(mailbox.kind === "inbox"
				? (unreadByMailbox.get(mailbox.id) ?? {
						unreadThreads: 0,
						unreadCount: 0,
					})
				: {}),
			recentThreads: recentByMailbox.get(mailbox.id) ?? [],
		})),
	}));
};

export const fetchMailboxOverview = cache(async () => {
	const user = await isSignedIn();
	if (!user?.id) return fetchMailboxOverviewUncached();

	return withServerCache(
		user.id,
		`mailbox-overview:${user.id}`,
		10,
		fetchMailboxOverviewUncached,
	);
});

export type FetchMailboxOverviewResult = Awaited<
	ReturnType<typeof fetchMailboxOverview>
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

export const revalidateMailbox = async (path: string) => {
	revalidatePath(path);
};

// Mail actions are server actions and can be called with arbitrary ids, and
// the worker processes their jobs with the service role. RLS only returns the
// caller's own rows, so use it to check ownership before queueing anything.
async function requireOwnedMailboxes(...mailboxIds: string[]) {
	const ids = Array.from(new Set(mailboxIds.filter(Boolean).map(String)));
	if (!ids.length) throw new Error("Mailbox not found");
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({ id: mailboxes.id })
			.from(mailboxes)
			.where(inArray(mailboxes.id, ids)),
	);
	if (rows.length !== ids.length) throw new Error("Mailbox not found");
}

async function requireOwnedIdentity(identityId: string) {
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx
			.select({ id: identities.id })
			.from(identities)
			.where(eq(identities.id, String(identityId)))
			.limit(1),
	);
	if (!identity) throw new Error("Identity not found");
}

// Cached sidebar/overview data must not outlive a change.
async function afterMailMutation(refresh = true) {
	const user = await isSignedIn();
	await invalidateServerCache(user?.id);
	if (refresh) revalidatePath("/dashboard/mail");
}

type AiReplySuggestionInput = {
	mode: "reply" | "forward" | "compose" | string;
	userInstruction?: string;
	currentHtml?: string;
	originalSubject?: string | null;
	originalText?: string | null;
	originalHtml?: string | null;
	originalFrom?: unknown;
	originalMessageId?: string | null;
};

const stripHtmlForPrompt = (value?: string | null) =>
	(value || "")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, 6000);

export async function generateAiReplySuggestion(
	input: AiReplySuggestionInput,
): Promise<FormState> {
	const user = await isSignedIn();
	if (!user) return { success: false, error: "Please sign in first." };

	const rls = await rlsClient();
	// Settings and the original message (the reply editor only has its
	// trimmed header data) in one transaction, through RLS.
	const { settings, original } = await rls(async (tx) => {
		const [settings] = await tx
			.select()
			.from(userAiSettings)
			.orderBy(desc(userAiSettings.updatedAt))
			.limit(1);
		if (!settings?.enabled || !input.originalMessageId) {
			return { settings, original: undefined };
		}
		const [original] = await tx
			.select({
				text: messages.text,
				html: messages.html,
				subject: messages.subject,
			})
			.from(messages)
			.where(eq(messages.id, String(input.originalMessageId)))
			.limit(1);
		return { settings, original };
	});

	if (!settings?.enabled) {
		return {
			success: false,
			error: "AI drafts are disabled in Platform settings.",
		};
	}

	const provider = toAiProvider(settings.provider);
	const defaults = getAiDefaults(provider);
	let baseUrl: string;
	try {
		baseUrl = await normalizeAiBaseUrl(settings.baseUrl || defaults.baseUrl);
	} catch (error) {
		return { success: false, error: (error as Error).message };
	}
	const model = settings.model || defaults.model;
	if (!model) return { success: false, error: "No AI model is configured." };
	const systemPrompt = (settings.systemPrompt || "").trim();
	const temperature = Number(settings.temperature ?? 0.4);
	const maxTokens = Number(settings.maxTokens ?? 700);

	let originalSource = input.originalText || input.originalHtml || "";
	let originalSubject = input.originalSubject;
	if (original) {
		originalSource = original.text || original.html || originalSource;
		originalSubject = originalSubject || original.subject;
	}
	const originalText = stripHtmlForPrompt(originalSource);
	const currentDraft = stripHtmlForPrompt(input.currentHtml || "");
	const instruction = (input.userInstruction || "").trim().slice(0, 1200);

	const prompt = `You are drafting an email inside Kurrier. Return only the proposed email body, no explanations, no subject line.

Mode: ${input.mode || "reply"}
Subject: ${originalSubject || "(none)"}
From: ${JSON.stringify(input.originalFrom || null)}

Default instruction:
${systemPrompt || "Write a concise, helpful, professional reply."}

User instruction / desired tone for this draft:
${instruction || "No extra instruction."}

Current draft, if any:
${currentDraft || "(empty)"}

Original email context:
${originalText || "(no original message context)"}

Rules:
- Match the user's instruction and language.
- Be concise unless the instruction asks for detail.
- Do not invent facts, dates, promises, prices, or attachments.
- Do not include greetings/signature if the current draft already contains them unless needed.
- Output plain text paragraphs only.`;

	const label = aiProviderLabel(provider);
	try {
		const suggestion = await runAiPrompt({
			provider,
			baseUrl,
			apiKey: settings.apiKey,
			model,
			prompt,
			temperature,
			maxTokens,
		});
		if (!suggestion) {
			return {
				success: false,
				error: `${label} returned an empty suggestion.`,
			};
		}
		return { success: true, data: { suggestion } };
	} catch (error) {
		const message = (error as Error)?.message || "";
		return {
			success: false,
			error: message.startsWith(label) ? message : `${label} is not reachable.`,
		};
	}
}

async function resolveSentMailboxIdFromMessageMailbox(
	messageMailboxId: string,
): Promise<string | null> {
	if (!messageMailboxId || messageMailboxId === "undefined") return null;

	const rls = await rlsClient();
	return await rls(async (tx) => {
		const [sourceMailbox] = await tx
			.select({ identityId: mailboxes.identityId })
			.from(mailboxes)
			.where(eq(mailboxes.id, messageMailboxId));

		if (!sourceMailbox?.identityId) return null;

		const candidateMailboxes = await tx
			.select({
				id: mailboxes.id,
				kind: mailboxes.kind,
				slug: mailboxes.slug,
				name: mailboxes.name,
			})
			.from(mailboxes)
			.where(eq(mailboxes.identityId, sourceMailbox.identityId));

		const sentMailbox =
			candidateMailboxes.find((mailbox) => mailbox.kind === "sent") ??
			candidateMailboxes.find((mailbox) => mailbox.slug === "sent") ??
			candidateMailboxes.find((mailbox) => mailbox.slug === "gesendet") ??
			candidateMailboxes.find((mailbox) =>
				mailbox.name?.toLowerCase().includes("sent"),
			) ??
			candidateMailboxes.find((mailbox) =>
				mailbox.name?.toLowerCase().includes("gesendet"),
			);

		return sentMailbox?.id ? String(sentMailbox.id) : null;
	});
}

export async function sendMail(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const decodedForm = decode(formData) as any;
	let sentMailboxId = String(decodedForm.sentMailboxId ?? "").trim();

	// A mailbox resolved below went through RLS; one sent by the client
	// still has to be checked.
	let sentMailboxOwned = false;
	if (!sentMailboxId || sentMailboxId === "undefined") {
		sentMailboxOwned = true;
		const messageMailboxId = String(
			decodedForm.messageMailboxId ?? decodedForm.mailboxId ?? "",
		).trim();
		sentMailboxId =
			(await resolveSentMailboxIdFromMessageMailbox(messageMailboxId)) ?? "";
	}

	if (!sentMailboxId || sentMailboxId === "undefined") {
		return {
			success: false,
			error:
				"Sender mailbox is not ready yet. Kurrier could not resolve the Sent mailbox for this message.",
		};
	}

	// The worker sends as the identity of this mailbox with the service role.
	if (!sentMailboxOwned) {
		try {
			await requireOwnedMailboxes(sentMailboxId);
		} catch {
			return { success: false, error: "Sender mailbox not found." };
		}
	}
	decodedForm.sentMailboxId = sentMailboxId;

	if (toArray(decodedForm.to as any).length === 0) {
		return {
			success: false,
			error: "Please provide at least one recipient in the To field.",
		};
	}

	const rls = await rlsClient();
	const draftId = decodedForm.draftId ? String(decodedForm.draftId) : "";
	delete decodedForm.draftId;
	const scheduledAtRaw = decodedForm.scheduledAt
		? String(decodedForm.scheduledAt)
		: "";
	if (scheduledAtRaw) {
		const d = dayjs(scheduledAtRaw);
		if (!d.isValid()) {
			return { success: false, error: "Invalid scheduled time." };
		}

		// Lookup and insert in one transaction.
		const row = await rls(async (tx) => {
			const [identity] = await tx
				.select({
					identityId: mailboxes.identityId,
				})
				.from(mailboxes)
				.where(eq(mailboxes.id, decodedForm.mailboxId));

			const parsed = DraftMessageInsertSchema.safeParse({
				identityId: identity?.identityId,
				mailboxId: decodedForm.mailboxId,
				payload: decodedForm,
				status: "scheduled",
				scheduledAt: d.toDate(),
			});
			if (!parsed.success) return "invalid" as const;

			const [created] = await tx
				.insert(draftMessages)
				.values(parsed.data)
				.returning({
					id: draftMessages.id,
					scheduledAt: draftMessages.scheduledAt,
				});
			return created ?? null;
		});

		if (row === "invalid") {
			return {
				success: false,
				error: "There was an error trying to schedule your mail.",
			};
		}

		if (!row?.id || !row.scheduledAt) {
			return { success: false, error: "Failed to schedule your mail." };
		}
		if (draftId) await deleteDraft(draftId);

		const sendMailQueue = getQueue("send-mail");
		const delay = Math.max(
			0,
			Number(new Date(row.scheduledAt)) - Number(new Date()),
		);

		await sendMailQueue.add(
			"send-scheduled-draft",
			{ draftMessageId: row.id },
			{ jobId: row.id, delay },
		);
		await afterMailMutation();
		return {
			success: true,
			message: "Message scheduled",
			data: { draftMessageId: row.id },
		};
	}

	let result: FormState;
	try {
		result = await addJobAndWait<FormState>(
			"send-mail",
			"send-and-reconcile",
			decodedForm,
		);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Failed to send email.",
		};
	}
	if (result?.success && draftId) await deleteDraft(draftId);
	// Show the sent reply in the open thread and the Sent folder.
	await afterMailMutation();
	return result;
}

export const deltaFetch = async ({ identityId }: { identityId: string }) => {
	await requireOwnedIdentity(identityId);
	try {
		const { smtpQueue } = await getSmtpQueue();
		const job = await smtpQueue.add(
			"delta-fetch",
			{ identityId },
			{
				jobId: `delta-fetch-${identityId}-${Date.now()}`,
				removeOnComplete: { age: 300 },
				removeOnFail: { age: 900 },
			},
		);
		const state = await job.getState();
		return {
			success: true,
			jobId: String(job.id),
			state,
			error: null,
		};
	} catch (error) {
		console.error("Failed to enqueue delta-fetch job", error);
		return {
			success: false,
			jobId: null,
			state: "failed",
			error: "Sync queue is unavailable. Please retry in a moment.",
		};
	}
};

export const deltaFetchAllMailboxes = async () => {
	try {
		const rls = await rlsClient();
		const rows = await rls((tx) =>
			tx
				.select({ identityId: identities.id })
				.from(identities)
				.innerJoin(mailboxes, eq(mailboxes.identityId, identities.id))
				.innerJoin(mailboxSync, eq(mailboxSync.mailboxId, mailboxes.id))
				.where(eq(identities.kind, "email")),
		);
		const identityIds = Array.from(
			new Set(rows.map((row) => row.identityId).filter(Boolean)),
		);

		if (identityIds.length === 0) {
			return {
				success: true,
				queued: 0,
				failed: 0,
				jobIds: [] as string[],
				error: null,
			};
		}

		const { smtpQueue } = await getSmtpQueue();
		const startedAt = Date.now();
		const settled = await Promise.allSettled(
			identityIds.map((identityId, index) =>
				smtpQueue.add(
					"delta-fetch",
					{ identityId },
					{
						jobId: `delta-fetch-${identityId}-${startedAt}-${index}`,
						removeOnComplete: { age: 300 },
						removeOnFail: { age: 900 },
					},
				),
			),
		);
		const jobIds = settled.flatMap((result) =>
			result.status === "fulfilled" ? [String(result.value.id)] : [],
		);
		const failed = settled.length - jobIds.length;

		revalidatePath("/dashboard/mail");

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
		return {
			success: false,
			queued: 0,
			failed: 0,
			jobIds: [] as string[],
			error: "Sync queue is unavailable. Please retry in a moment.",
		};
	}
};

export const getDeltaFetchStatus = async ({ jobId }: { jobId: string }) => {
	try {
		const { smtpQueue } = await getSmtpQueue();
		const job = await smtpQueue.getJob(jobId);

		if (!job) {
			return {
				success: false,
				state: "missing",
				error: "Sync job was not found. It may already have been cleaned up.",
			};
		}

		const state = await job.getState();
		const failedReason = job.failedReason;

		return {
			success: state !== "failed",
			jobId: String(job.id),
			state,
			error: failedReason || null,
		};
	} catch (error) {
		console.error("Failed to read delta-fetch job status", error);
		return {
			success: false,
			state: "failed",
			error: "Sync queue is unavailable. Please retry in a moment.",
		};
	}
};

export const initSearch = async (
	query: string,
	ownerId: string,
	hasAttachment: boolean,
	onlyUnread: boolean,
	starred: boolean,
	page: number,
): Promise<SearchThreadsResponse> => {
	// Never trust the owner id sent by the client.
	const user = await isSignedIn();
	if (!user?.id || (ownerId && ownerId !== user.id)) {
		return { items: [], totalThreads: 0, totalMessages: 0 };
	}
	const client = getTypeSenseClient();

	const filters = [`ownerId:=${JSON.stringify(user.id)}`];
	if (hasAttachment) filters.push("hasAttachment:=1");
	if (onlyUnread) filters.push("unread:=1");
	if (starred) filters.push("starred:=1"); // NEW

	const result = (await client
		.collections("messages")
		.documents()
		.search({
			q: query,
			query_by: "subject,html,text,fromName,fromEmail,participants",
			filter_by: filters.join(" && "),
			sort_by: "createdAt:desc",
			group_by: "threadId",
			group_limit: 1,
			per_page: PAGE_SIZE,
			page,
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
			starred: Number(d.starred) === 1, // NEW (if you want to use it in UI)
			createdAt: d.createdAt ?? 0,
			lastInThreadAt: d.lastInThreadAt ?? d.createdAt ?? 0,
		})),
		totalThreads: result?.found ?? sourceHits.length,
		totalMessages: result?.found_docs ?? sourceHits.length,
	};
};

export const backfillMailboxes = async (identityId: string) => {
	await requireOwnedIdentity(identityId);
	await addJobAndWait(
		"smtp-worker",
		"imap:backfill-discover",
		{ identityId },
		{
			jobId: `imap-backfill-discover-${identityId}`,
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 1000,
			},
		},
	);
	await queueBackfill(identityId);
};

// Ownership is checked by the caller.
async function queueBackfill(identityId: string) {
	const smtpQueue = getQueue("smtp-worker");
	await smtpQueue.add(
		"imap:backfill-tick",
		{},
		{
			removeOnComplete: true,
			removeOnFail: true,
			jobId: "imap-backfill-tick-on-demand",
		},
	);
	await smtpQueue.add(
		"imap:start-idle",
		{ identityId },
		{
			removeOnComplete: true,
			removeOnFail: false,
			attempts: 3,
			backoff: { type: "exponential", delay: 1500 },
		},
	);
}

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

export const fetchAdjacentMailboxThreads = cache(
	async (identityPublicId: string, mailboxSlug: string, threadId: string) => {
		const rls = await rlsClient();
		const now = new Date();
		const effectiveActivityAt = sql`COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt})`;
		const visibleInMailbox = and(
			eq(mailboxThreads.identityPublicId, identityPublicId),
			eq(mailboxThreads.mailboxSlug, mailboxSlug),
			or(
				isNull(mailboxThreads.snoozedUntil),
				lte(mailboxThreads.snoozedUntil, now),
			),
		);

		return rls(async (tx) => {
			const [current] = await tx
				.select({
					threadId: mailboxThreads.threadId,
					effectiveActivityAt,
					lastActivityAt: mailboxThreads.lastActivityAt,
				})
				.from(mailboxThreads)
				.where(and(visibleInMailbox, eq(mailboxThreads.threadId, threadId)))
				.limit(1);

			if (!current) {
				return { previousThreadId: null, nextThreadId: null };
			}

			const cursorEffectiveActivityAt =
				current.effectiveActivityAt instanceof Date
					? current.effectiveActivityAt.toISOString()
					: String(current.effectiveActivityAt);
			const cursorLastActivityAt =
				current.lastActivityAt instanceof Date
					? current.lastActivityAt.toISOString()
					: String(current.lastActivityAt);
			const cursorThreadId = String(current.threadId);
			const cursor = sql`(${cursorEffectiveActivityAt}::timestamptz, ${cursorLastActivityAt}::timestamptz, ${cursorThreadId}::uuid)`;

			const [previous] = await tx
				.select({ threadId: mailboxThreads.threadId })
				.from(mailboxThreads)
				.where(
					and(
						visibleInMailbox,
						sql`(
							COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt}),
							${mailboxThreads.lastActivityAt},
							${mailboxThreads.threadId}
						) > ${cursor}`,
					),
				)

				.orderBy(
					asc(effectiveActivityAt),
					asc(mailboxThreads.lastActivityAt),
					asc(mailboxThreads.threadId),
				)
				.limit(1);

			const [next] = await tx
				.select({ threadId: mailboxThreads.threadId })
				.from(mailboxThreads)
				.where(
					and(
						visibleInMailbox,
						sql`(
							COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt}),
							${mailboxThreads.lastActivityAt},
							${mailboxThreads.threadId}
						) < ${cursor}`,
					),
				)

				.orderBy(
					desc(effectiveActivityAt),
					desc(mailboxThreads.lastActivityAt),
					desc(mailboxThreads.threadId),
				)
				.limit(1);

			return {
				previousThreadId: previous?.threadId ?? null,
				nextThreadId: next?.threadId ?? null,
			};
		});
	},
);

// RLS only updates the caller's own rows, so the returned thread ids are
// exactly the ones the worker (service role) may touch.
async function setThreadsSeen(
	ids: string[],
	mailboxId: string,
	seen: boolean,
): Promise<string[]> {
	const now = new Date();
	const rls = await rlsClient();

	return rls(async (tx) => {
		await tx
			.update(messages)
			.set({ seen, updatedAt: now })
			.where(
				and(inArray(messages.threadId, ids), eq(messages.mailboxId, mailboxId)),
			);

		const updated = await tx
			.update(mailboxThreads)
			.set({
				// Unread: one statement for all threads; falls back to 1 so a
				// thread surfaces as unread even if no message row matched.
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
		return updated.map((row) => row.threadId);
	});
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

	const ownedIds = await setThreadsSeen(ids, mailboxId, seen);

	await afterMailMutation(refresh);

	if (markSmtp && ownedIds.length) {
		await Promise.all([
			enqueueThreadSmtpJobs("mail:set-flags", ownedIds, () => ({
				mailboxId,
				op: seen ? "read" : "unread",
			})),
			enqueueSearchRefresh(ownedIds),
		]);
	}
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

	await Promise.all([
		enqueueThreadSmtpJobs("mail:move", ids, () => ({
			mailboxId,
			op,
			messageId,
			moveImap,
		})),
		enqueueSearchRefresh(ids),
	]);

	await afterMailMutation(refresh);
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

export const toggleStar = async (
	threadId: string,
	mailboxId: string,
	starred: boolean,
	starImap: boolean,
) => {
	if (!threadId || !mailboxId) return;
	await requireOwnedMailboxes(mailboxId);
	const op = starred ? "unflag" : "flag";

	if (starImap) {
		await enqueueThreadSmtpJobs(
			"mail:set-flags",
			[threadId],
			() => ({ mailboxId, op }),
			() => ({ ...RETRY_JOB_OPTS, removeOnComplete: true, removeOnFail: true }),
		);
	} else {
		const rls = await rlsClient();
		await rls(async (tx) => {
			const now = new Date();
			await tx
				.update(messages)
				.set({ flagged: op === "flag", updatedAt: now })
				.where(
					and(
						eq(messages.threadId, threadId),
						eq(messages.mailboxId, mailboxId),
					),
				);

			const [agg] = await tx
				.select({
					unreadCount: sql<number>`count(*) filter (where ${messages.seen} = false)`,
					anyFlagged: sql<boolean>`bool_or(${messages.flagged})`,
				})
				.from(messages)
				.where(
					and(
						eq(messages.threadId, threadId),
						eq(messages.mailboxId, mailboxId),
					),
				);

			await tx
				.update(mailboxThreads)
				.set({
					unreadCount: agg.unreadCount ?? 0,
					starred: agg.anyFlagged ?? false,
					updatedAt: now,
				})
				.where(
					and(
						eq(mailboxThreads.threadId, threadId),
						eq(mailboxThreads.mailboxId, mailboxId),
					),
				);
		});
	}

	await enqueueSearchRefresh([threadId]);

	await afterMailMutation();
};

export const setStarForThreads = async (
	threadIds: string | string[],
	mailboxId: string,
	starred: boolean,
	starImap: boolean,
	refresh = true,
) => {
	const ids = toIdList(threadIds);

	if (!ids.length || !mailboxId) return;
	await requireOwnedMailboxes(mailboxId);

	if (starImap) {
		await enqueueThreadSmtpJobs("mail:set-flags", ids, () => ({
			mailboxId,
			op: starred ? "flag" : "unflag",
		}));
	} else {
		const rls = await rlsClient();
		await rls(async (tx) => {
			const now = new Date();
			await tx
				.update(messages)
				.set({ flagged: starred, updatedAt: now })
				.where(
					and(
						inArray(messages.threadId, ids),
						eq(messages.mailboxId, mailboxId),
					),
				);

			await tx
				.update(mailboxThreads)
				.set({ starred, updatedAt: now })
				.where(
					and(
						inArray(mailboxThreads.threadId, ids),
						eq(mailboxThreads.mailboxId, mailboxId),
					),
				);
		});
	}

	await enqueueSearchRefresh(ids);

	await afterMailMutation(refresh);
};

export const fetchMailboxThreads = async (
	identityPublicId: string,
	mailboxSlug: string,
	page: number,
) => {
	page = page && page > 0 ? page : 1;

	const rls = await rlsClient();

	const now = new Date();
	const effectiveActivityAt = sql`COALESCE(${mailboxThreads.unsnoozedAt}, ${mailboxThreads.lastActivityAt})`;

	const threads = await rls((tx) =>
		tx
			.select()
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
			.offset((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE),
	);

	return threads;
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
	const { emptyAll = false } = opts ?? {};
	if (!mailboxId) return;
	await requireOwnedMailboxes(mailboxId);

	const deleteOpts = {
		...RETRY_JOB_OPTS,
		removeOnComplete: true,
		removeOnFail: true,
	};

	if (emptyAll) {
		await getQueue("smtp-worker").add(
			"mail:delete-permanent",
			{ mailboxId, emptyAll: true, imapDelete },
			deleteOpts,
		);
		await afterMailMutation(refresh);
		return;
	}

	const ids = toIdList(threadIds);
	if (!ids.length) return;

	await Promise.all([
		enqueueThreadSmtpJobs(
			"mail:delete-permanent",
			ids,
			() => ({ mailboxId, imapDelete }),
			() => deleteOpts,
		),
		enqueueSearchRefresh(ids),
	]);

	await afterMailMutation(refresh);
}

export async function addNewMailboxFolder(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	const decodedForm = decode(formData);
	const isImapOp = String(decodedForm.imapOp).trim().length > 0;
	const user = await isSignedIn();
	if (!user?.id) return { success: false, error: "Please sign in first." };
	await requireOwnedIdentity(String(decodedForm.identityId));
	if (decodedForm.parentId && decodedForm.parentId !== "none") {
		await requireOwnedMailboxes(String(decodedForm.parentId));
	}
	if (isImapOp) {
		await addJobAndWait(
			"smtp-worker",
			"mailbox:add-new",
			{
				name: decodedForm.name,
				parentId: decodedForm.parentId,
				identityId: decodedForm.identityId,
				ownerId: user?.id,
				kind: "custom",
				slug: slugify(String(decodedForm.name)),
			},
			{ ...RETRY_JOB_OPTS, removeOnComplete: true, removeOnFail: true },
		);
		await afterMailMutation();
	} else {
		const name = String(decodedForm.name ?? "").trim();
		if (!name)
			return { success: false, error: "Folder name is required" } as any;

		const ownerId = String(user?.id ?? "");
		const identityId = String(decodedForm.identityId);
		const parentId =
			decodedForm.parentId && decodedForm.parentId !== "none"
				? String(decodedForm.parentId)
				: null;

		if (parentId) {
			const [parent] = await db
				.select({ id: mailboxes.id, identityId: mailboxes.identityId })
				.from(mailboxes)
				.where(eq(mailboxes.id, parentId))
				.limit(1);

			if (!parent || parent.identityId !== identityId) {
				return { success: false, error: "Invalid parent folder" } as any;
			}
		}

		await db
			.insert(mailboxes)
			.values({
				ownerId,
				identityId,
				parentId,
				kind: "custom",
				name,
				slug: slugify(name.toLowerCase()),
				isDefault: false,
				metaData: {},
			})
			.returning();

		await afterMailMutation();
	}

	return {
		success: true,
	};
}

export async function deleteMailboxFolder({
	imapOp,
	identityId,
	mailboxId,
}: {
	imapOp: boolean;
	identityId: string;
	mailboxId: string;
}): Promise<FormState> {
	const user = await isSignedIn();
	if (!user?.id) return { success: false, error: "Please sign in first." };
	await requireOwnedMailboxes(mailboxId);

	if (!imapOp) {
		const [mailbox] = await db
			.select()
			.from(mailboxes)
			.where(eq(mailboxes.id, mailboxId))
			.limit(1);

		if (!mailbox) return { success: false, error: "Folder not found" } as any;
		if (mailbox.isDefault)
			return { success: false, error: "Cannot delete a default folder" } as any;

		// Delete any subfolders first
		await db.delete(mailboxes).where(eq(mailboxes.parentId, mailboxId));

		// Delete this mailbox and any sync info
		await db.delete(mailboxSync).where(eq(mailboxSync.mailboxId, mailboxId));
		await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));

		await afterMailMutation();
		return { success: true };
	}

	const [ident] = await db
		.select({ id: identities.id })
		.from(identities)
		.where(
			and(eq(identities.publicId, identityId), eq(identities.ownerId, user.id)),
		)
		.limit(1);

	if (!ident) throw new Error("Identity not found");

	await addJobAndWait(
		"smtp-worker",
		"mailbox:delete-folder",
		{
			mailboxId,
			identityId: ident.id,
			ownerId: user?.id,
		},
		{ ...RETRY_JOB_OPTS, removeOnComplete: true, removeOnFail: true },
	);
	await invalidateServerCache(user.id);
	redirect(`/dashboard/mail/${identityId}/inbox`);
	return { success: true };
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

	await Promise.all([
		enqueueThreadSmtpJobs(
			"mail:move",
			ids,
			() => ({
				mailboxId: fromMailboxId,
				op: "move",
				toMailboxId,
				messageId,
				moveImap,
			}),
			(threadId) => ({
				...RETRY_JOB_OPTS,
				jobId: `move:${threadId}:${fromMailboxId}->${toMailboxId}`,
				removeOnComplete: true,
				removeOnFail: false,
			}),
		),
		enqueueSearchRefresh(ids),
	]);

	await afterMailMutation(refresh);
};

export const clearImapClients = async (identityId: string) => {
	await requireOwnedIdentity(identityId);
	await getQueue("smtp-worker").add(
		"imap:stop-idle",
		{ identityId },
		{ ...RETRY_JOB_OPTS, removeOnComplete: true, removeOnFail: false },
	);
};

const fetchScheduledDraftCountsUncached = async () => {
	const rls = await rlsClient();
	// Only the columns the sidebar counts need; payloads can be large.
	const rows = await rls((tx) =>
		tx
			.select({
				id: draftMessages.id,
				identityId: draftMessages.identityId,
				status: draftMessages.status,
			})
			.from(draftMessages)
			.where(inArray(draftMessages.status, ["scheduled", "draft"])),
	);
	return rows;
};

export type DraftPayload = {
	mode?: "reply" | "forward" | "compose";
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	bodyHtml?: string;
	text?: string;
	attachments?: string;
	originalMessageId?: string;
	threadUrl?: string;
};

// Autosaved, not yet sent messages (status "draft").
export async function saveDraft(input: {
	draftId?: string | null;
	sentMailboxId: string;
	payload: DraftPayload;
}): Promise<{ draftId: string | null; error?: string }> {
	if (!input.sentMailboxId) return { draftId: input.draftId ?? null };
	const rls = await rlsClient();
	try {
		return await rls(async (tx) => {
			const [mailbox] = await tx
				.select({ identityId: mailboxes.identityId })
				.from(mailboxes)
				.where(eq(mailboxes.id, input.sentMailboxId));
			if (!mailbox) return { draftId: input.draftId ?? null };

			const values = {
				mailboxId: input.sentMailboxId,
				identityId: mailbox.identityId,
				payload: input.payload as Record<string, any>,
				updatedAt: new Date(),
			};

			if (input.draftId) {
				const [updated] = await tx
					.update(draftMessages)
					.set(values)
					.where(
						and(
							eq(draftMessages.id, input.draftId),
							eq(draftMessages.status, "draft"),
						),
					)
					.returning({ id: draftMessages.id });
				// Gone (sent or discarded meanwhile): do not resurrect it.
				return { draftId: updated?.id ?? null };
			}

			const [created] = await tx
				.insert(draftMessages)
				.values({ ...values, status: "draft" })
				.returning({ id: draftMessages.id });
			return { draftId: created?.id ?? null, created: true };
		}).then(
			async ({
				created,
				...result
			}: {
				draftId: string | null;
				created?: boolean;
			}) => {
				// A new draft changes the sidebar draft count.
				if (created) await afterMailMutation(false);
				return result;
			},
		);
	} catch (error) {
		return {
			draftId: input.draftId ?? null,
			error: error instanceof Error ? error.message : "Could not save draft",
		};
	}
}

export async function deleteDraft(draftId: string) {
	if (!draftId) return;
	const rls = await rlsClient();
	await rls((tx) =>
		tx
			.delete(draftMessages)
			.where(
				and(eq(draftMessages.id, draftId), eq(draftMessages.status, "draft")),
			),
	);
	await afterMailMutation();
}

export async function fetchDraftForMessage(originalMessageId: string) {
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select()
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.status, "draft"),
					sql`${draftMessages.payload}->>'originalMessageId' = ${originalMessageId}`,
				),
			)
			.orderBy(desc(draftMessages.updatedAt))
			.limit(1),
	);
	return row ?? null;
}

export const fetchDrafts = async (identityPublicId: string) => {
	const rls = await rlsClient();
	return rls((tx) =>
		tx
			.select(getTableColumns(draftMessages))
			.from(draftMessages)
			.innerJoin(identities, eq(identities.id, draftMessages.identityId))
			.where(
				and(
					eq(draftMessages.status, "draft"),
					eq(identities.publicId, identityPublicId),
				),
			)
			.orderBy(desc(draftMessages.updatedAt)),
	);
};

export const fetchScheduledDraftCounts = cache(async () => {
	const user = await isSignedIn();
	if (!user?.id) return fetchScheduledDraftCountsUncached();

	return withServerCache(user.id, `scheduled-draft-counts:${user.id}`, 15, () =>
		fetchScheduledDraftCountsUncached(),
	);
});

export const fetchScheduledDrafts = async (identityPublicId: string) => {
	const rls = await rlsClient();
	return rls((tx) =>
		tx
			.select(getTableColumns(draftMessages))
			.from(draftMessages)
			.innerJoin(identities, eq(identities.id, draftMessages.identityId))
			.where(
				and(
					eq(draftMessages.status, "scheduled"),
					eq(identities.publicId, identityPublicId),
				),
			),
	);
};

export async function deleteScheduledDraft(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData) as Record<string, unknown>;
		const draftId = String(decodedForm.draftId);
		const rls = await rlsClient();
		const deleted = await rls((tx) =>
			tx
				.delete(draftMessages)
				.where(eq(draftMessages.id, draftId))
				.returning({ id: draftMessages.id }),
		);

		// Also drop the delayed send job (jobId = draft id).
		if (deleted.length) {
			try {
				const job = await getQueue("send-mail").getJob(draftId);
				await job?.remove();
			} catch (error) {
				console.warn("Could not remove scheduled send job", error);
			}
		}

		await afterMailMutation();
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

		await afterMailMutation();
		return { success: true };
	});
}

const fetchIdentitySnoozedThreadsUncached = async (
	identityPublicId?: string,
) => {
	// Without an identity, return all snoozed threads for account-wide sidebar counts.

	const rls = await rlsClient();
	const now = new Date();

	const threads = await rls((tx) => {
		return tx
			.select()
			.from(mailboxThreads)
			.where(
				and(
					identityPublicId
						? eq(mailboxThreads.identityPublicId, identityPublicId)
						: undefined,
					isNotNull(mailboxThreads.snoozedUntil),
					gt(mailboxThreads.snoozedUntil, now),
				),
			)
			.orderBy(
				desc(mailboxThreads.snoozedUntil),
				desc(mailboxThreads.lastActivityAt),
			);
	});

	return { threads };
};

export const fetchIdentitySnoozedThreads = cache(
	async (identityPublicId?: string) => {
		const user = await isSignedIn();
		if (!user?.id) return fetchIdentitySnoozedThreadsUncached(identityPublicId);

		return withServerCache(
			user.id,
			`snoozed-threads:${user.id}:${identityPublicId ?? "all"}`,
			15,
			() => fetchIdentitySnoozedThreadsUncached(identityPublicId),
		);
	},
);

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

type MailSubscriptionRow = typeof mailSubscriptions.$inferSelect;

export async function fetchThreadMailSubscriptions(opts: {
	ownerId: string;
	messages: Array<{ id: string; headersJson: any }>;
}) {
	const keysByMessageId = new Map<string, string>();
	// Callable as a server action: only ever read the caller's own rows.
	const user = await isSignedIn();
	if (!user?.id || user.id !== opts.ownerId) {
		return {
			byMessageId: new Map<string, MailSubscriptionRow | null>(),
			keysByMessageId,
		};
	}

	for (const m of opts.messages) {
		const key = subscriptionKeyFromHeadersJson(m.headersJson);
		if (key) keysByMessageId.set(m.id, key);
	}

	const uniqueKeys = Array.from(new Set(keysByMessageId.values()));
	if (!uniqueKeys.length) {
		return {
			byMessageId: new Map<string, MailSubscriptionRow | null>(),
			keysByMessageId,
		};
	}

	const rows = await db
		.select()
		.from(mailSubscriptions)
		.where(
			and(
				eq(mailSubscriptions.ownerId, opts.ownerId),
				inArray(mailSubscriptions.subscriptionKey, uniqueKeys),
			),
		);

	const byKey = new Map(rows.map((r) => [r.subscriptionKey, r]));
	const byMessageId = new Map<string, MailSubscriptionRow | null>();

	for (const [messageId, key] of keysByMessageId.entries()) {
		byMessageId.set(messageId, byKey.get(key) ?? null);
	}

	return { byMessageId, keysByMessageId };
}

export type FetchThreadMailSubsResult = Awaited<
	ReturnType<typeof fetchThreadMailSubscriptions>
>;

function isPrivateAddress(address: string) {
	if (address === "localhost") return true;
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return (
			a === 10 ||
			a === 127 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			a === 0
		);
	}
	if (isIP(address) === 6) {
		const normalized = address.toLowerCase();
		return (
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			normalized.startsWith("fe80:")
		);
	}
	return false;
}

async function assertSafeUnsubscribeUrl(rawUrl: string) {
	const url = new URL(rawUrl);
	if (!["https:", "http:"].includes(url.protocol)) {
		throw new Error("Unsupported unsubscribe URL protocol");
	}
	if (url.username || url.password) {
		throw new Error("Unsubscribe URL must not contain credentials");
	}
	if (isPrivateAddress(url.hostname)) {
		throw new Error("Unsafe unsubscribe host");
	}
	const addresses = await lookup(url.hostname, { all: true, verbatim: true });
	if (
		!addresses.length ||
		addresses.some((addr) => isPrivateAddress(addr.address))
	) {
		throw new Error("Unsafe unsubscribe DNS target");
	}
	return url;
}

export async function oneClickUnsubscribe(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData);
		const id = String(decodedForm.mailSubscriptionId);
		const rls = await rlsClient();
		const [sub] = await rls((tx) =>
			tx
				.select()
				.from(mailSubscriptions)
				.where(and(eq(mailSubscriptions.id, id)))
				.limit(1),
		);
		if (!sub?.unsubscribeHttpUrl)
			return { success: false, error: "Subscription not found" };

		const url = await assertSafeUnsubscribeUrl(sub.unsubscribeHttpUrl);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
		});
		if (res.status < 200 || res.status >= 400) {
			return {
				success: false,
				error: `Unsubscribe failed: HTTP ${res.status}`,
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
				.where(eq(mailSubscriptions.id, id)),
		);
		revalidatePath(
			typeof decodedForm.pathname === "string" && decodedForm.pathname
				? decodedForm.pathname
				: "/dashboard/mail",
		);
		return { success: true };
	});
}
