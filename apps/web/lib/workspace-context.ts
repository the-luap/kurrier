// Not a "use server" module: takes a user id, so it must never be callable
// from the browser. The server action wrapper is updateWorkSpaceContext in
// lib/actions/workspace.ts (always the signed-in user).
import "server-only";

import { db, workspaceMembers, workspaces } from "@db";
import { ThemeNameSchema, WORKSPACE_THEME_COOKIE } from "@schema";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";

/**
 * Remember the selected workspace in cookies after checking that `userId`
 * is a member. The cookies are only a selection hint: every request checks
 * membership again (lib/actions/clients.ts) and the role is always read
 * from the database.
 */
export async function setWorkspaceContextCookies(
	workspacePublicId: string,
	id: string,
	userId: string,
) {
	if (!userId) {
		throw new Error("Not authenticated.");
	}

	const [[member], [workspace]] = await Promise.all([
		db
			.select({ role: workspaceMembers.role })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, String(id)),
					eq(workspaceMembers.userId, userId),
				),
			)
			.limit(1),
		db
			.select({ theme: workspaces.theme })
			.from(workspaces)
			.where(
				and(
					eq(workspaces.id, String(id)),
					eq(workspaces.publicId, String(workspacePublicId)),
				),
			)
			.limit(1),
	]);

	if (!member || !workspace) {
		throw new Error("Workspace not found.");
	}

	const cookieStore = await cookies();
	const secure = process.env.NODE_ENV === "production";

	cookieStore.set({
		name: "workspaceId",
		value: String(id),
		httpOnly: true,
		secure,
		sameSite: "lax",
		path: "/",
	});

	cookieStore.set({
		name: "workspacePublicId",
		value: String(workspacePublicId),
		httpOnly: true,
		secure,
		sameSite: "lax",
		path: "/",
	});

	cookieStore.set({
		name: "workspaceRole",
		value: member.role,
		httpOnly: true,
		secure,
		sameSite: "lax",
		path: "/",
	});

	cookieStore.set({
		name: WORKSPACE_THEME_COOKIE,
		value: ThemeNameSchema.catch("indigo").parse(workspace.theme),
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 365,
	});
}
