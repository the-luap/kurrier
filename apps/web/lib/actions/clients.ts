import {currentSession, isSignedIn} from "@/lib/actions/auth";
import {createDrizzleClientInstance, workspaceMembers, workspaces} from "@db";
import {cookies} from "next/headers";
import {and, eq, or} from "drizzle-orm";
import {cache} from "react";

function usableCookieValue(value?: string) {
	if (!value || value === "undefined" || value === "null") return undefined;
	return value;
}

const currentWorkspaceContext = cache(async () => {
	const cookieStore = await cookies();
	const cookieWorkspaceId = usableCookieValue(cookieStore.get("workspaceId")?.value);
	const cookieWorkspacePublicId = usableCookieValue(cookieStore.get("workspacePublicId")?.value);
	const user = await isSignedIn();
	const userId = user?.id;

	if (!userId) return undefined;

	const session = await currentSession();
	const { admin } = await createDrizzleClientInstance(session, {});

	const accessibleFilter = or(
		eq(workspaces.ownerId, userId),
		eq(workspaceMembers.userId, userId),
	);

	if (cookieWorkspaceId || cookieWorkspacePublicId) {
		const selected = await admin
			.select({
				id: workspaces.id,
				publicId: workspaces.publicId,
				ownerId: workspaces.ownerId,
				memberRole: workspaceMembers.role,
			})
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
					accessibleFilter,
				),
			)
			.limit(1);

		if (selected[0]) {
			return {
				id: selected[0].id,
				publicId: selected[0].publicId,
				role: selected[0].ownerId === userId ? "owner" : selected[0].memberRole || "member",
			};
		}
	}

	const fallback = await admin
		.select({
			id: workspaces.id,
			publicId: workspaces.publicId,
			ownerId: workspaces.ownerId,
			memberRole: workspaceMembers.role,
		})
		.from(workspaces)
		.leftJoin(
			workspaceMembers,
			eq(workspaceMembers.workspaceId, workspaces.id),
		)
		.where(accessibleFilter)
		.limit(1);

	if (!fallback[0]) return undefined;

	return {
		id: fallback[0].id,
		publicId: fallback[0].publicId,
		role: fallback[0].ownerId === userId ? "owner" : fallback[0].memberRole || "member",
	};
});


export const getWorkspaceId = async () => {
	const workspace = await currentWorkspaceContext();
	if (!workspace?.id) throw new Error("No workspace selected");
	return workspace.id;
};

export const getWorkspacePublicId = async () => {
	const workspace = await currentWorkspaceContext();
	if (!workspace?.publicId) throw new Error("No workspace selected");
	return workspace.publicId;
};

export const getWorkspaceRole = async () => {
	const cookieStore = await cookies();
	const role = usableCookieValue(cookieStore.get("workspaceRole")?.value);
	if (role) return role;
	const workspace = await currentWorkspaceContext();
	return workspace?.role;
};


export const rlsClient = async () => {
	const workspaceId = await getWorkspaceId();
	if (!workspaceId) throw new Error("No workspace selected");

	return rlsClientForWorkspace(workspaceId);
};

export const rlsClientForWorkspace = async (workspaceId: string) => {
	const session = await currentSession();
	const user = await isSignedIn();
	const userId = user?.id;
	if (!userId) throw new Error("Not authenticated");

	const { admin } = await createDrizzleClientInstance(session, {});

	const rows = await admin
		.select({ id: workspaces.id })
		.from(workspaces)
		.leftJoin(
			workspaceMembers,
			eq(workspaceMembers.workspaceId, workspaces.id),
		)
		.where(
			and(
				eq(workspaces.id, workspaceId),
				or(
					eq(workspaces.ownerId, userId),
					eq(workspaceMembers.userId, userId),
				),
			),
		)
		.limit(1);

	if (!rows.length) throw new Error("Workspace not found or no access");

	const { rls } = await createDrizzleClientInstance(session, {
		workspaceId,
	});

	return rls;
};
