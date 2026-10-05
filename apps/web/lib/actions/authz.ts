// Server-only authorization helpers for server actions and route handlers.
// Deliberately NOT a "use server" module: nothing here may be callable from
// the browser.
import "server-only";

import { isSignedIn } from "@/lib/actions/auth";
import { getWorkspaceId, getWorkspaceRole } from "@/lib/actions/clients";
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export const WORKSPACE_ADMIN_ROLES = ["owner", "admin"] as const;

export const isWorkspaceAdminRole = (role: string | null | undefined) =>
	(WORKSPACE_ADMIN_ROLES as readonly string[]).includes(String(role ?? ""));

/** The signed-in user, or throws. */
export async function requireUser() {
	const user = await isSignedIn();
	if (!user?.id) throw new Error("Not authenticated");
	return user;
}

/**
 * Signed-in user plus the current workspace and the caller's role in it.
 * The role is always read from the database (never from a cookie).
 */
export async function requireWorkspaceMember() {
	const user = await requireUser();
	const [workspaceId, role] = await Promise.all([
		getWorkspaceId(),
		getWorkspaceRole(),
	]);
	return { user, userId: user.id, workspaceId, role };
}

/**
 * Workspace settings, providers, identities, vault, API keys, webhooks and
 * similar workspace-wide administration: owners and admins only.
 */
export async function requireWorkspaceAdmin() {
	const member = await requireWorkspaceMember();
	if (!isWorkspaceAdminRole(member.role)) {
		throw new Error("You do not have permission to manage this workspace.");
	}
	return member;
}

/**
 * Row filter for tables whose RLS is workspace-wide (messages, threads,
 * mailboxes, attachments, drafts, ...). Inside an RLS transaction the
 * identities policy hides identities restricted to other members, so this
 * keeps only rows of mailboxes whose identity the caller may see.
 * Only meaningful inside rlsClient() transactions.
 */
export const mailboxVisibleSql = (mailboxIdColumn: PgColumn | SQL): SQL =>
	sql`exists (select 1 from mailboxes vm inner join identities vi on vi.id = vm.identity_id where vm.id = ${mailboxIdColumn})`;

/** Same as mailboxVisibleSql for rows that reference an identity directly. */
export const identityVisibleSql = (identityIdColumn: PgColumn | SQL): SQL =>
	sql`exists (select 1 from identities vi where vi.id = ${identityIdColumn})`;

/** Same as mailboxVisibleSql for rows that reference a message. */
export const messageVisibleSql = (messageIdColumn: PgColumn | SQL): SQL =>
	sql`exists (select 1 from messages vmsg inner join mailboxes vm on vm.id = vmsg.mailbox_id inner join identities vi on vi.id = vm.identity_id where vmsg.id = ${messageIdColumn})`;
