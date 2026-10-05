"use server";

import { PAGE_SIZE } from "@common/mail-client";
import {
	contactLabels,
	db,
	identities,
	type LabelCreate,
	type LabelEntity,
	LabelInsertSchema,
	labels,
	mailboxThreadLabels,
	mailboxThreads,
} from "@db";
import { type FormState, handleAction, type LabelScope } from "@schema";
import slugify from "@sindresorhus/slugify";
import { decode } from "decode-formdata";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getWorkspaceId, rlsClient } from "@/lib/actions/clients";
import { addBulkAndWait, addJobAndWait } from "@/lib/actions/get-redis";
import { isGmailMetaData } from "@/lib/mail-jobs";
import type { FetchMailboxThreadsResult } from "@/lib/actions/mailbox";

const DEFAULT_JOB_OPTS = {
	attempts: 3,
	backoff: { type: "exponential" as const, delay: 1500 },
	removeOnComplete: true,
	removeOnFail: true,
};

export const fetchLabelsByIdentityPublicId = async ({
	identityPublicId,
	scope,
}: {
	identityPublicId: string;
	scope?: LabelScope;
}): Promise<LabelEntity[]> => {
	const rls = await rlsClient();
	const selectedScope = scope ?? "thread";

	const rows = await rls((tx) =>
		tx
			.select({ label: labels })
			.from(labels)
			.innerJoin(identities, eq(labels.identityId, identities.id))
			.where(
				and(
					eq(identities.publicId, identityPublicId),
					eq(labels.scope, selectedScope),
				),
			)
			.orderBy(asc(labels.name)),
	);

	return rows.map((r) => r.label);
};

export const fetchLabels = async (
	scope?: LabelScope,
): Promise<LabelEntity[]> => {
	const selectedScope = scope ?? "thread";
	const workspaceId = await getWorkspaceId();

	const rows = await db
		.select()
		.from(labels)
		.where(
			and(eq(labels.scope, selectedScope), eq(labels.workspaceId, workspaceId)),
		)
		.orderBy(asc(labels.name));

	return rows as LabelEntity[];
};

type LabelWithCount = typeof labels.$inferSelect & {
	threadCount: number;
};

export const fetchLabelsWithCounts = async () => {
	const rls = await rlsClient();

	const rows = await rls((tx) =>
		tx
			.select({
				label: labels,
				identityPublicId: identities.publicId,
				threadCount: sql<number>`count(${mailboxThreadLabels.threadId})`,
			})
			.from(labels)
			.innerJoin(identities, eq(labels.identityId, identities.id))
			.leftJoin(mailboxThreadLabels, eq(mailboxThreadLabels.labelId, labels.id))
			.where(eq(labels.scope, "thread"))
			.groupBy(labels.id, identities.publicId)
			.orderBy(asc(labels.name)),
	);

	const result = new Map<string, LabelWithCount[]>();

	for (const row of rows) {
		const key = row.identityPublicId;
		const existing = result.get(key) ?? [];

		existing.push({
			...row.label,
			threadCount: Number(row.threadCount ?? 0),
		});

		result.set(key, existing);
	}

	return result;
};

export type FetchLabelsWithCountResult = Awaited<
	ReturnType<typeof fetchLabelsWithCounts>
>;

export type FetchLabelsResult = Awaited<ReturnType<typeof fetchLabels>>;

export const fetchContactLabelsWithCounts = async () => {
	const rls = await rlsClient();

	const rows = await rls((tx) =>
		tx
			.select({
				label: labels,
				contactCount: sql<number>`count(${contactLabels.contactId})`,
			})
			.from(labels)
			.leftJoin(contactLabels, eq(contactLabels.labelId, labels.id))
			.where(eq(labels.scope, "contact"))
			.groupBy(labels.id)
			.orderBy(asc(labels.name)),
	);

	return rows.map((r) => ({
		...r.label,
		contactCount: Number(r.contactCount ?? 0),
	}));
};

export type FetchContactLabelsWithCountResult = Awaited<
	ReturnType<typeof fetchContactLabelsWithCounts>
>;

// Only labels of the caller's workspace (RLS).
async function fetchDescendantLabelIds(parentId: string): Promise<string[]> {
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({
				id: labels.id,
				parentId: labels.parentId,
			})
			.from(labels),
	);

	const childrenByParent = new Map<string, string[]>();

	for (const row of rows) {
		if (!row.parentId) continue;
		childrenByParent.set(row.parentId, [
			...(childrenByParent.get(row.parentId) ?? []),
			row.id,
		]);
	}

	const result: string[] = [];
	const stack = [...(childrenByParent.get(parentId) ?? [])];

	while (stack.length) {
		const id = stack.pop()!;
		result.push(id);
		stack.push(...(childrenByParent.get(id) ?? []));
	}

	return result;
}

async function enqueueGmailJob(name: string, data: Record<string, unknown>) {
	await addJobAndWait("gmail-worker", name, data, DEFAULT_JOB_OPTS);
}

/**
 * Labels visible through RLS (the caller's workspace), with whether their
 * identity is a Gmail identity. Gmail jobs run with the service role, so
 * they are only queued for labels returned here.
 */
async function fetchOwnedLabels(labelIds: string[]) {
	const ids = Array.from(new Set(labelIds.filter(Boolean).map(String)));
	if (!ids.length) return [];
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({ label: labels, identityMeta: identities.metaData })
			.from(labels)
			.leftJoin(identities, eq(identities.id, labels.identityId))
			.where(inArray(labels.id, ids)),
	);
	return rows.map((row) => {
		const gmailLabelId = (row.label.metaData as any)?.gmail?.labelId as
			| string
			| undefined;
		return {
			label: row.label,
			isGmail:
				Boolean(row.label.identityId) && isGmailMetaData(row.identityMeta),
			gmailLabelId: gmailLabelId ?? null,
		};
	});
}

export async function addNewLabel(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	return handleAction(async () => {
		const decodedForm = decode(formData);

		const payload = LabelInsertSchema.parse({
			name: decodedForm.name,
			colorBg: decodedForm.color,
			scope: decodedForm.scope,
			slug: slugify(String(decodedForm.name)),
			parentId:
				decodedForm.parentId && decodedForm.parentId !== "none"
					? String(decodedForm.parentId)
					: undefined,
		});

		let isGmail = false;

		const rls = await rlsClient();

		if (decodedForm.scope === "thread") {
			// RLS: only an identity of the caller's workspace.
			const [identity] = await rls((tx) =>
				tx
					.select({ id: identities.id, metaData: identities.metaData })
					.from(identities)
					.where(eq(identities.publicId, String(decodedForm.identityPublicId)))
					.limit(1),
			);

			if (!identity) {
				return { success: false, error: "labels.invalidIdentity" };
			}

			payload.identityId = identity.id;
			isGmail = isGmailMetaData(identity.metaData);
		}

		if (payload.parentId) {
			const [parent] = await fetchOwnedLabels([String(payload.parentId)]);
			if (!parent) return { success: false, error: "Invalid parent label" };
		}

		const newLabelRows = await rls((tx) =>
			tx
				.insert(labels)
				.values(payload as LabelCreate)
				.returning(),
		);

		const newLabel = newLabelRows[0];

		if (isGmail && newLabel?.id) {
			await enqueueGmailJob("gmail:label:create", {
				labelId: newLabel.id,
			});
		}

		revalidatePath("/");
		return { success: true, data: newLabelRows };
	});
}

export async function addLabelToThread({
	threadId,
	mailboxId,
	labelId,
}: {
	threadId: string;
	mailboxId: string;
	labelId: string;
}): Promise<FormState> {
	return handleAction(async () => {
		const rls = await rlsClient();

		// Thread and label must both be the caller's (RLS) before the worker
		// is asked to label anything.
		const [[thread], [owned]] = await Promise.all([
			rls((tx) =>
				tx
					.select({
						ownerId: mailboxThreads.ownerId,
						workspaceId: mailboxThreads.workspaceId,
					})
					.from(mailboxThreads)
					.where(
						and(
							eq(mailboxThreads.threadId, threadId),
							eq(mailboxThreads.mailboxId, mailboxId),
						),
					)
					.limit(1),
			),
			fetchOwnedLabels([labelId]),
		]);

		if (!thread) {
			throw new Error(`Mailbox thread not found: ${threadId} / ${mailboxId}`);
		}
		if (!owned) {
			throw new Error("Label not found");
		}

		await rls((tx) =>
			tx
				.insert(mailboxThreadLabels)
				.values({
					threadId,
					mailboxId,
					labelId,
					ownerId: thread.ownerId,
					workspaceId: thread.workspaceId,
				})
				.onConflictDoNothing(),
		);

		if (owned.isGmail && owned.gmailLabelId) {
			await enqueueGmailJob("gmail:thread-label:add", {
				threadId,
				mailboxId,
				labelId,
			});
		}

		revalidatePath("/");
		return { success: true };
	});
}

export async function removeLabelFromThread({
	threadId,
	mailboxId,
	labelId,
}: {
	threadId: string;
	mailboxId: string;
	labelId: string;
}): Promise<FormState> {
	return handleAction(async () => {
		const rls = await rlsClient();

		const removed = await rls((tx) =>
			tx
				.delete(mailboxThreadLabels)
				.where(
					and(
						eq(mailboxThreadLabels.threadId, threadId),
						eq(mailboxThreadLabels.mailboxId, mailboxId),
						eq(mailboxThreadLabels.labelId, labelId),
					),
				)
				.returning({ labelId: mailboxThreadLabels.labelId }),
		);

		// Only a row RLS let us delete proves thread and label are ours.
		const [owned] = removed.length ? await fetchOwnedLabels([labelId]) : [];

		if (owned?.isGmail && owned.gmailLabelId) {
			await enqueueGmailJob("gmail:thread-label:remove", {
				threadId,
				mailboxId,
				labelId,
			});
		}

		revalidatePath("/");
		return { success: true };
	});
}

export async function addLabelToContact({
	contactId,
	labelId,
}: {
	contactId: string;
	labelId: string;
}): Promise<FormState> {
	return handleAction(async () => {
		const rls = await rlsClient();

		await rls((tx) =>
			tx.insert(contactLabels).values({
				contactId,
				labelId,
			}),
		);

		revalidatePath("/dashboard/contacts");
		return { success: true };
	});
}

export async function removeLabelFromContact({
	contactId,
	labelId,
}: {
	contactId: string;
	labelId: string;
}): Promise<FormState> {
	return handleAction(async () => {
		const rls = await rlsClient();

		await rls((tx) =>
			tx
				.delete(contactLabels)
				.where(
					and(
						eq(contactLabels.contactId, contactId),
						eq(contactLabels.labelId, labelId),
					),
				),
		);

		revalidatePath("/dashboard/contacts");
		return { success: true };
	});
}

export const fetchMailboxThreadLabels = async (
	threads: FetchMailboxThreadsResult | { threadId: string }[],
) => {
	const rls = await rlsClient();
	const threadIds = threads.map((t) => t.threadId).filter(Boolean);

	if (!threadIds.length) return {};

	const rows = await rls((tx) =>
		tx
			.select({
				mt: mailboxThreadLabels,
				l: labels,
			})
			.from(mailboxThreadLabels)
			.innerJoin(labels, eq(mailboxThreadLabels.labelId, labels.id))
			.where(inArray(mailboxThreadLabels.threadId, threadIds)),
	);

	const byThreadId: Record<string, any[]> = {};

	for (const { mt, l } of rows) {
		byThreadId[mt.threadId] ??= [];
		byThreadId[mt.threadId].push({ mt, label: l });
	}

	return byThreadId;
};

export type FetchMailboxThreadLabelsResult = Awaited<
	ReturnType<typeof fetchMailboxThreadLabels>
>;

export const fetchContactLabelsByContactIds = async (contactIds: string[]) => {
	if (!contactIds.length) return {};

	const rls = await rlsClient();
	const workspaceId = await getWorkspaceId();

	const rows = await rls((tx) =>
		tx
			.select({
				cl: contactLabels,
				l: labels,
			})
			.from(contactLabels)
			.innerJoin(labels, eq(contactLabels.labelId, labels.id))
			.where(
				and(
					inArray(contactLabels.contactId, contactIds),
					eq(contactLabels.workspaceId, workspaceId),
				),
			),
	);

	const byContactId: Record<string, { label: LabelEntity }[]> = {};

	for (const { cl, l } of rows) {
		byContactId[cl.contactId] ??= [];
		byContactId[cl.contactId].push({ label: l });
	}

	return byContactId;
};

export type FetchContactLabelsByIdResult = Awaited<
	ReturnType<typeof fetchContactLabelsByContactIds>
>;

export const fetchMailboxThreadsByLabel = async (
	identityPublicId: string,
	mailboxSlug: string,
	labelSlug: string,
	page: number,
) => {
	const rls = await rlsClient();
	const pageNum = page > 0 ? page : 1;
	const offset = (pageNum - 1) * PAGE_SIZE;

	const where = and(
		eq(mailboxThreads.identityPublicId, identityPublicId),
		eq(mailboxThreads.mailboxSlug, mailboxSlug),
		eq(labels.slug, labelSlug),
	);

	const rows = await rls((tx) =>
		tx
			.select({ thread: mailboxThreads })
			.from(mailboxThreads)
			.innerJoin(
				mailboxThreadLabels,
				and(
					eq(mailboxThreadLabels.threadId, mailboxThreads.threadId),
					eq(mailboxThreadLabels.mailboxId, mailboxThreads.mailboxId),
				),
			)
			.innerJoin(labels, eq(mailboxThreadLabels.labelId, labels.id))
			.where(where)
			.orderBy(desc(mailboxThreads.lastActivityAt))
			.offset(offset)
			.limit(PAGE_SIZE),
	);

	const [{ total }] = await rls((tx) =>
		tx
			.select({ total: sql<number>`count(*)` })
			.from(mailboxThreads)
			.innerJoin(
				mailboxThreadLabels,
				and(
					eq(mailboxThreadLabels.threadId, mailboxThreads.threadId),
					eq(mailboxThreadLabels.mailboxId, mailboxThreads.mailboxId),
				),
			)
			.innerJoin(labels, eq(mailboxThreadLabels.labelId, labels.id))
			.where(where),
	);

	return {
		threads: rows.map((r) => r.thread),
		total: Number(total ?? 0),
	};
};

export type FetchMailboxThreadsByLabelResult = Awaited<
	ReturnType<typeof fetchMailboxThreadsByLabel>
>;

export const deleteLabel = async ({ id }: { id: string }) => {
	try {
		// Ownership first (RLS), then the Gmail jobs, then the rows: the
		// worker reads the label row, so it must still exist while the job
		// runs.
		const owned = await fetchOwnedLabels([id]);
		if (!owned.length) {
			return { success: false, error: "Label not found" };
		}

		const labelIdsToDelete = [id, ...(await fetchDescendantLabelIds(id))];
		const rows = await fetchOwnedLabels(labelIdsToDelete);
		const ownedIds = rows.map((row) => row.label.id);

		await addBulkAndWait(
			"gmail-worker",
			rows
				.filter((row) => row.isGmail && row.gmailLabelId)
				.map((row) => ({
					name: "gmail:label:delete",
					data: { labelId: row.label.id },
					opts: DEFAULT_JOB_OPTS,
				})),
		);

		const rls = await rlsClient();

		await rls(async (tx) => {
			await tx
				.delete(mailboxThreadLabels)
				.where(inArray(mailboxThreadLabels.labelId, ownedIds));

			await tx
				.delete(contactLabels)
				.where(inArray(contactLabels.labelId, ownedIds));

			await tx.delete(labels).where(inArray(labels.id, ownedIds));
		});

		revalidatePath("/");
		return { success: true };
	} catch (err: any) {
		console.error("DELETE LABEL FAILED", err);
		return { success: false, error: err?.message ?? "Unknown error" };
	}
};

export const updateLabel = async ({
	id,
	name,
	parentId,
	color,
}: {
	id: string;
	name: string;
	parentId: string | null;
	color: string;
}) => {
	try {
		const [owned] = await fetchOwnedLabels([id]);
		if (!owned) {
			return { success: false, error: "Label not found" };
		}
		if (parentId) {
			if (parentId === id) {
				return { success: false, error: "Invalid parent label" };
			}
			const [parent] = await fetchOwnedLabels([parentId]);
			if (!parent) return { success: false, error: "Invalid parent label" };
		}

		const descendantIds = await fetchDescendantLabelIds(id);
		if (parentId && descendantIds.includes(parentId)) {
			return { success: false, error: "Invalid parent label" };
		}

		const rls = await rlsClient();

		await rls((tx) =>
			tx
				.update(labels)
				.set({
					name,
					slug: slugify(name),
					parentId,
					colorBg: color,
					updatedAt: new Date(),
				})
				.where(eq(labels.id, id)),
		);

		if (owned.isGmail) {
			await addBulkAndWait(
				"gmail-worker",
				[id, ...descendantIds].map((labelId) => ({
					name: "gmail:label:update",
					data: { labelId },
					opts: DEFAULT_JOB_OPTS,
				})),
			);
		}

		revalidatePath("/");
		return { success: true };
	} catch (err: any) {
		return { success: false, error: err?.message ?? "Unknown error" };
	}
};

export async function getOrCreateSystemLabel({
	name,
	scope,
	colorBg,
}: {
	name: string;
	scope: LabelScope;
	colorBg?: string | null;
}): Promise<LabelEntity> {
	const rls = await rlsClient();
	const workspaceId = await getWorkspaceId();

	const [existing] = await rls((tx) =>
		tx
			.select()
			.from(labels)
			.where(
				and(
					eq(labels.slug, slugify(name)),
					eq(labels.scope, scope),
					eq(labels.workspaceId, workspaceId),
				),
			)
			.limit(1),
	);

	if (existing) return existing as LabelEntity;

	const payload = LabelInsertSchema.parse({
		name,
		slug: slugify(name),
		isSystem: true,
		scope,
		colorBg: colorBg ?? null,
		parentId: undefined,
	});

	const [inserted] = await rls((tx) =>
		tx
			.insert(labels)
			.values(payload as LabelCreate)
			.returning(),
	);

	return inserted as LabelEntity;
}

export async function toggleFavoriteContact(formData: FormData) {
	await handleAction(async () => {
		const decodedForm = decode(formData);
		const contactId = String(decodedForm.contactId);
		const rls = await rlsClient();
		const workspaceId = await getWorkspaceId();

		let [favorite] = await rls((tx) =>
			tx
				.select()
				.from(labels)
				.where(
					and(
						eq(labels.slug, "favorite"),
						eq(labels.scope, "contact"),
						eq(labels.workspaceId, workspaceId),
					),
				)
				.limit(1),
		);

		if (!favorite) {
			const rows = await rls((tx) =>
				tx
					.insert(labels)
					.values({
						name: "Favorite",
						slug: "favorite",
						scope: "contact",
						isSystem: true,
						colorBg: "#eab308",
					})
					.returning(),
			);

			favorite = rows[0];
		}

		const existing = await rls((tx) =>
			tx
				.select()
				.from(contactLabels)
				.where(
					and(
						eq(contactLabels.contactId, contactId),
						eq(contactLabels.labelId, favorite.id),
					),
				)
				.limit(1),
		);

		if (existing.length) {
			await rls((tx) =>
				tx
					.delete(contactLabels)
					.where(
						and(
							eq(contactLabels.contactId, contactId),
							eq(contactLabels.labelId, favorite.id),
						),
					),
			);

			revalidatePath("/");
			return { success: true, isFavorite: false };
		}

		await rls((tx) =>
			tx.insert(contactLabels).values({
				contactId,
				labelId: favorite.id,
			}),
		);

		revalidatePath("/");
		return { success: true, isFavorite: true };
	});
}
