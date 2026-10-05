import { currentSession, isSignedIn } from "@/lib/actions/auth";
import {
	createDrizzleClientInstance,
	db,
	workspaceMembers,
	workspaces,
} from "@db";
import { cookies } from "next/headers";
import { and, asc, eq, or } from "drizzle-orm";
import { cache } from "react";

type WorkspaceContext = {
	id: string;
	publicId: string;
	role: string;
};

function usableCookieValue(value?: string) {
	if (!value || value === "undefined" || value === "null") return undefined;
	return value;
}

const accessibleBy = (userId: string) =>
	or(eq(workspaces.ownerId, userId), eq(workspaceMembers.userId, userId));

const workspaceContextColumns = {
	id: workspaces.id,
	publicId: workspaces.publicId,
	ownerId: workspaces.ownerId,
	memberRole: workspaceMembers.role,
	memberUserId: workspaceMembers.userId,
};

type WorkspaceContextRow = {
	id: string;
	publicId: string;
	ownerId: string;
	memberRole: string | null;
	memberUserId: string | null;
};

function toContext(rows: WorkspaceContextRow[], userId: string) {
	const row = rows[0];
	if (!row) return undefined;
	// The left join can return one row per member; prefer the caller's own.
	const own = rows.find((r) => r.memberUserId === userId);
	return {
		id: row.id,
		publicId: row.publicId,
		role:
			row.ownerId === userId
				? "owner"
				: String(own?.memberRole ?? row.memberRole ?? "member"),
	} satisfies WorkspaceContext;
}

/**
 * Workspace of the current request: the one in the cookies if the signed-in
 * user may access it, otherwise the user's first workspace. Cached per
 * request. Never returns the string "undefined" for a missing cookie.
 */
const currentWorkspaceContext = cache(
	async (): Promise<WorkspaceContext | undefined> => {
		const cookieStore = await cookies();
		const cookieWorkspaceId = usableCookieValue(
			cookieStore.get("workspaceId")?.value,
		);
		const cookieWorkspacePublicId = usableCookieValue(
			cookieStore.get("workspacePublicId")?.value,
		);
		const user = await isSignedIn();
		const userId = user?.id;
		if (!userId) return undefined;

		if (cookieWorkspaceId || cookieWorkspacePublicId) {
			const selected = await db
				.select(workspaceContextColumns)
				.from(workspaces)
				.leftJoin(
					workspaceMembers,
					eq(workspaceMembers.workspaceId, workspaces.id),
				)
				.where(
					and(
						cookieWorkspaceId
							? eq(workspaces.id, cookieWorkspaceId)
							: eq(workspaces.publicId, String(cookieWorkspacePublicId)),
						accessibleBy(userId),
					),
				)
				.limit(5)
				.catch(() => [] as WorkspaceContextRow[]);

			const ctx = toContext(selected, userId);
			if (ctx) return ctx;
		}

		const fallback = await db
			.select(workspaceContextColumns)
			.from(workspaces)
			.leftJoin(
				workspaceMembers,
				eq(workspaceMembers.workspaceId, workspaces.id),
			)
			.where(accessibleBy(userId))
			.orderBy(asc(workspaces.createdAt))
			.limit(5);

		return toContext(fallback, userId);
	},
);

export const getWorkspaceId = async () => {
	const workspace = await currentWorkspaceContext();
	if (!workspace?.id) throw new Error("No workspace selected");
	return workspace.id;
};

/** Public id of the current workspace, or "" when there is none. */
export const getWorkspacePublicId = async () => {
	const workspace = await currentWorkspaceContext();
	return workspace?.publicId ?? "";
};

export const getWorkspaceRole = async () => {
	const workspace = await currentWorkspaceContext();
	if (!workspace) return "";
	const cookieStore = await cookies();
	const cookieWorkspaceId = usableCookieValue(
		cookieStore.get("workspaceId")?.value,
	);
	// The role cookie belongs to the cookie workspace only.
	if (cookieWorkspaceId === workspace.id) {
		const role = usableCookieValue(cookieStore.get("workspaceRole")?.value);
		if (role) return role;
	}
	return workspace.role;
};

/** Membership check, deduplicated per request. */
const hasWorkspaceAccess = cache(
	async (workspaceId: string, userId: string) => {
		const rows = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.leftJoin(
				workspaceMembers,
				eq(workspaceMembers.workspaceId, workspaces.id),
			)
			.where(and(eq(workspaces.id, workspaceId), accessibleBy(userId)))
			.limit(1);
		return rows.length > 0;
	},
);

export const rlsClient = async () => {
	const workspaceId = await getWorkspaceId();
	return rlsClientForWorkspace(workspaceId);
};

export const rlsClientForWorkspace = async (workspaceId: string) => {
	const user = await isSignedIn();
	const userId = user?.id;
	if (!userId) throw new Error("Not authenticated");

	if (!(await hasWorkspaceAccess(workspaceId, userId))) {
		throw new Error("Workspace not found or no access");
	}

	const session = await currentSession();
	const { rls } = await createDrizzleClientInstance(session, {
		workspaceId,
	});

	return rls;
};
