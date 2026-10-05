import {
	db,
	identities,
	mailboxes,
	messageAttachments,
	messages,
	workspaceIdentityMembers,
} from "@db";
import {
	and,
	asc,
	eq,
	exists,
	getTableColumns,
	inArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { getQuery, type H3Event } from "h3";
import { type ApiActor, UUID_RE } from "../api-helpers";

/**
 * Identities an API actor may read mail of, mirroring the identities RLS
 * policy: same workspace as the key, and the identity is owned by the key's
 * user, shared with the workspace, or the user is an identity member.
 */
export function accessibleIdentityCondition(actor: ApiActor): SQL {
	return and(
		eq(identities.workspaceId, actor.workspaceId),
		or(
			eq(identities.ownerId, actor.ownerId),
			eq(identities.sharedWithWorkspace, true),
			exists(
				db
					.select({ one: sql`1` })
					.from(workspaceIdentityMembers)
					.where(
						and(
							eq(workspaceIdentityMembers.workspaceId, actor.workspaceId),
							eq(workspaceIdentityMembers.userId, actor.ownerId),
							eq(workspaceIdentityMembers.identityId, identities.id),
						),
					),
			),
		),
	) as SQL;
}

/** Matches a row by uuid `id` or by its short `publicId`. */
export function idOrPublicId(
	idColumn: typeof mailboxes.id | typeof messages.id,
	publicIdColumn: typeof mailboxes.publicId | typeof messages.publicId,
	value: string,
): SQL {
	return UUID_RE.test(value) ? eq(idColumn, value) : eq(publicIdColumn, value);
}

/** Mailbox (by id or publicId) whose identity the actor may access. */
export async function findAccessibleMailbox(actor: ApiActor, id: string) {
	const [row] = await db
		.select({ mailbox: mailboxes, identity: identities })
		.from(mailboxes)
		.innerJoin(identities, eq(mailboxes.identityId, identities.id))
		.where(
			and(
				idOrPublicId(mailboxes.id, mailboxes.publicId, id),
				eq(mailboxes.workspaceId, actor.workspaceId),
				accessibleIdentityCondition(actor),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Ids of all mailboxes the actor may read. */
export function accessibleMailboxIdsQuery(actor: ApiActor) {
	return db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.innerJoin(identities, eq(mailboxes.identityId, identities.id))
		.where(
			and(
				eq(mailboxes.workspaceId, actor.workspaceId),
				accessibleIdentityCondition(actor),
			),
		);
}

export const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const MAX_OFFSET = 10_000;

export function readPagination(event: H3Event) {
	const query = getQuery(event);
	const rawLimit = Number(query.limit ?? DEFAULT_LIMIT);
	const rawOffset = Number(query.offset ?? 0);
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
		: DEFAULT_LIMIT;
	const offset = Number.isFinite(rawOffset)
		? Math.min(Math.max(Math.trunc(rawOffset), 0), MAX_OFFSET)
		: 0;
	return { limit, offset };
}

/**
 * Fetches `limit + 1` rows to tell whether another page exists, then trims.
 */
export function paginate<T>(
	rows: T[],
	{ limit, offset }: { limit: number; offset: number },
) {
	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	return {
		items,
		pagination: {
			limit,
			offset,
			nextOffset:
				hasMore && offset + limit <= MAX_OFFSET ? offset + limit : null,
		},
	};
}

function queryFlag(value: unknown, fallback: boolean) {
	if (value === undefined || value === null || value === "") return fallback;
	const str = String(Array.isArray(value) ? value[0] : value).toLowerCase();
	return str === "true" || str === "1" || str === "yes";
}

export type BodyOptions = {
	includeHtml: boolean;
	includeText: boolean;
	includeHeaders: boolean;
};

/**
 * Bodies are left out of list responses unless requested
 * (`includeHtml=true`, `includeText=true`, `includeHeaders=true`).
 * Single-message reads include html and text by default.
 */
export function readBodyOptions(
	event: H3Event,
	defaults: Partial<BodyOptions> = {},
): BodyOptions {
	const query = getQuery(event);
	return {
		includeHtml: queryFlag(query.includeHtml, defaults.includeHtml ?? false),
		includeText: queryFlag(query.includeText, defaults.includeText ?? false),
		includeHeaders: queryFlag(
			query.includeHeaders,
			defaults.includeHeaders ?? false,
		),
	};
}

type FullMessageRow = typeof messages.$inferSelect;
type BodyColumn = "html" | "text" | "textAsHtml" | "headersJson";
type MessageRow = Omit<
	FullMessageRow,
	BodyColumn | "rawStorageKey" | "metaData"
> &
	Partial<Pick<FullMessageRow, BodyColumn>>;
type AttachmentRow = typeof messageAttachments.$inferSelect;

/**
 * Columns to select for API message responses: never the raw EML key or
 * internal metadata, and bodies/headers only when requested.
 */
export function messageColumns(options: BodyOptions) {
	const {
		html,
		text,
		textAsHtml,
		headersJson,
		rawStorageKey: _raw,
		metaData: _meta,
		...base
	} = getTableColumns(messages);
	return {
		...base,
		...(options.includeHtml ? { html } : {}),
		...(options.includeText ? { text, textAsHtml } : {}),
		...(options.includeHeaders ? { headersJson } : {}),
	};
}

export function serializeAttachment(attachment: AttachmentRow) {
	return {
		id: attachment.id,
		messageId: attachment.messageId,
		filename: attachment.filenameOriginal,
		contentType: attachment.contentType,
		sizeBytes: attachment.sizeBytes,
		cid: attachment.cid,
		isInline: attachment.isInline,
	};
}

export function serializeMessage(
	message: MessageRow,
	options: BodyOptions,
	attachments: AttachmentRow[] = [],
) {
	return {
		id: message.id,
		publicId: message.publicId,
		mailboxId: message.mailboxId,
		threadId: message.threadId,
		messageId: message.messageId,
		inReplyTo: message.inReplyTo,
		references: message.references,
		subject: message.subject,
		snippet: message.snippet,
		from: message.from,
		to: message.to,
		cc: message.cc,
		bcc: message.bcc,
		replyTo: message.replyTo,
		date: message.date,
		sizeBytes: message.sizeBytes,
		seen: message.seen,
		answered: message.answered,
		flagged: message.flagged,
		draft: message.draft,
		state: message.state,
		priority: message.priority,
		hasAttachments: message.hasAttachments,
		createdAt: message.createdAt,
		updatedAt: message.updatedAt,
		...(options.includeText
			? { text: message.text, textAsHtml: message.textAsHtml }
			: {}),
		...(options.includeHtml ? { html: message.html } : {}),
		...(options.includeHeaders ? { headers: message.headersJson } : {}),
		attachments: attachments.map(serializeAttachment),
	};
}

export async function serializeMessagesWithAttachments(
	actor: ApiActor,
	rows: MessageRow[],
	options: BodyOptions,
) {
	const attachmentRows = rows.length
		? await db
				.select()
				.from(messageAttachments)
				.where(
					and(
						eq(messageAttachments.workspaceId, actor.workspaceId),
						inArray(
							messageAttachments.messageId,
							rows.map((m) => m.id),
						),
					),
				)
		: [];

	const byMessage = new Map<string, AttachmentRow[]>();
	for (const attachment of attachmentRows) {
		const list = byMessage.get(attachment.messageId) ?? [];
		list.push(attachment);
		byMessage.set(attachment.messageId, list);
	}

	return rows.map((row) =>
		serializeMessage(row, options, byMessage.get(row.id) ?? []),
	);
}

export function serializeMailbox(mailbox: typeof mailboxes.$inferSelect) {
	return {
		id: mailbox.id,
		publicId: mailbox.publicId,
		identityId: mailbox.identityId,
		parentId: mailbox.parentId,
		kind: mailbox.kind,
		name: mailbox.name,
		slug: mailbox.slug,
		isDefault: mailbox.isDefault,
		createdAt: mailbox.createdAt,
		updatedAt: mailbox.updatedAt,
	};
}

export function serializeIdentity(identity: typeof identities.$inferSelect) {
	return {
		id: identity.id,
		publicId: identity.publicId,
		kind: identity.kind,
		value: identity.value,
		displayName: identity.displayName,
		status: identity.status,
		sharedWithWorkspace: identity.sharedWithWorkspace,
	};
}

/** Orders standard folders first (inbox, drafts, sent, ...), then by name. */
export const mailboxKindOrder = sql`
	CASE ${mailboxes.kind}
	WHEN 'inbox' THEN 0
	WHEN 'drafts' THEN 1
	WHEN 'sent' THEN 2
	WHEN 'archive' THEN 3
	WHEN 'spam' THEN 4
	WHEN 'trash' THEN 5
	WHEN 'outbox' THEN 6
	ELSE 7
	END
`;

/**
 * Email identities the actor can read, each with its mailboxes (standard
 * folders first). Optionally limited to one identity (id or publicId).
 */
export async function listMailboxesByIdentity(
	actor: ApiActor,
	identityId?: string,
) {
	const rows = await db
		.select({ identity: identities, mailbox: mailboxes })
		.from(identities)
		.leftJoin(
			mailboxes,
			and(
				eq(identities.id, mailboxes.identityId),
				eq(mailboxes.workspaceId, actor.workspaceId),
			),
		)
		.where(
			and(
				eq(identities.kind, "email"),
				accessibleIdentityCondition(actor),
				identityId
					? UUID_RE.test(identityId)
						? eq(identities.id, identityId)
						: eq(identities.publicId, identityId)
					: undefined,
			),
		)
		.orderBy(asc(identities.value), mailboxKindOrder, asc(mailboxes.name));

	const byIdentity = new Map<
		string,
		{
			identity: ReturnType<typeof serializeIdentity>;
			mailboxes: ReturnType<typeof serializeMailbox>[];
		}
	>();
	for (const row of rows) {
		const entry = byIdentity.get(row.identity.id) ?? {
			identity: serializeIdentity(row.identity),
			mailboxes: [],
		};
		if (row.mailbox) entry.mailboxes.push(serializeMailbox(row.mailbox));
		byIdentity.set(row.identity.id, entry);
	}
	return Array.from(byIdentity.values());
}
