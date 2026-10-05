import {
	db,
	identities,
	mailboxes,
	type MessageEntity,
	webhooks,
	workspaceIdentityMembers,
	workspaceMembers,
	workspaces,
} from "@db";
import { safeHttpRequest } from "@providers/net-guard";
import { and, eq, isNull, or, sql } from "drizzle-orm";

const WEBHOOK_TIMEOUT_MS = 15_000;

/**
 * Users allowed to receive the mail of `identity` through a webhook that is
 * not bound to an identity: the identity owner, everybody when it is shared
 * with the workspace, otherwise its assigned members. They must still belong
 * to the workspace (removed members keep no access through old webhooks).
 */
async function usersWithIdentityAccess(identity: {
	id: string;
	ownerId: string;
	workspaceId: string;
	sharedWithWorkspace: boolean;
}) {
	const [workspace] = await db
		.select({ ownerId: workspaces.ownerId })
		.from(workspaces)
		.where(eq(workspaces.id, identity.workspaceId))
		.limit(1);
	const members = await db
		.select({ userId: workspaceMembers.userId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.workspaceId, identity.workspaceId));

	const inWorkspace = new Set(members.map((m) => m.userId));
	if (workspace?.ownerId) inWorkspace.add(workspace.ownerId);

	if (identity.sharedWithWorkspace) return inWorkspace;

	const assigned = await db
		.select({ userId: workspaceIdentityMembers.userId })
		.from(workspaceIdentityMembers)
		.where(
			and(
				eq(workspaceIdentityMembers.identityId, identity.id),
				eq(workspaceIdentityMembers.workspaceId, identity.workspaceId),
			),
		);

	const allowed = new Set<string>();
	for (const userId of [identity.ownerId, ...assigned.map((a) => a.userId)]) {
		if (inWorkspace.has(userId)) allowed.add(userId);
	}
	return allowed;
}

export const processWebhook = async ({
	message,
	rawEmail,
}: {
	message: MessageEntity;
	rawEmail: string;
}) => {
	const [row] = await db
		.select({ mailbox: mailboxes, identity: identities })
		.from(mailboxes)
		.innerJoin(identities, eq(mailboxes.identityId, identities.id))
		.where(eq(mailboxes.id, message.mailboxId));

	if (!row) return;
	const { mailbox, identity } = row;

	const candidates = await db
		.select()
		.from(webhooks)
		.where(
			and(
				// Webhooks without an identity apply to all identities of their
				// workspace, not to every workspace's mail.
				eq(webhooks.workspaceId, mailbox.workspaceId),
				or(
					eq(webhooks.identityId, mailbox.identityId),
					isNull(webhooks.identityId),
				),
				sql`${webhooks.events} @> '{message.received}'::webhook_list[]`,
				eq(webhooks.enabled, true),
			),
		);

	if (!candidates.length) return;

	// A workspace-wide webhook must not leak the mail of identities its
	// owner cannot read (private identities of other members).
	const allowedOwners = await usersWithIdentityAccess(identity);
	const hooks = candidates.filter((hook) => allowedOwners.has(hook.ownerId));

	if (!hooks.length) return;

	const body = JSON.stringify({
		event: "message.received",
		data: {
			message,
			rawEmail,
		},
	});

	// Deliver in parallel with a timeout: one slow endpoint used to block the
	// common worker (and every other hook) indefinitely. URLs are user
	// supplied: private/internal and metadata addresses are refused (see
	// OUTBOUND_ALLOW_PRIVATE_NETWORKS) and redirects are not followed.
	await Promise.all(
		hooks.map(async (hook) => {
			try {
				const res = await safeHttpRequest(hook.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"user-agent": "Kurrier-Webhooks",
						"x-kurrier-event": "message.received",
					},
					body,
					timeoutMs: WEBHOOK_TIMEOUT_MS,
					maxResponseBytes: 64 * 1024,
					// Delivery is judged by the status only: a large
					// response body must not turn a delivered hook into
					// a failure.
					truncateOk: true,
				});
				if (res.status >= 300) {
					console.warn(
						`[webhook] ${hook.id} answered HTTP ${res.status} (redirects are not followed)`,
					);
				}
			} catch (err) {
				console.error(
					`[webhook] delivery failed for webhook ${hook.id}:`,
					(err as Error).message,
				);
			}
		}),
	);
};
