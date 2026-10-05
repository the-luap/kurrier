import { identities } from "@db";
import { eq } from "drizzle-orm";
import DeleteIdentityButton from "@/components/mailbox/settings/delete-identity-button";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { isWorkspaceAdminRole } from "@/lib/actions/authz";
import {
	getWorkspacePublicId,
	getWorkspaceRole,
	rlsClient,
} from "@/lib/actions/clients";
import { getDictionary, type Locale } from "@/lib/dictionaries";

async function Page({
	params,
}: {
	params: Promise<{ locale: Locale; identityPublicId: string }>;
}) {
	const { locale, identityPublicId } = await params;
	const [dict, rls, workspacePublicId, workspaceRole] = await Promise.all([
		getDictionary(locale),
		rlsClient(),
		getWorkspacePublicId(),
		getWorkspaceRole(),
	]);
	// Deleting an identity is an owner/admin operation (deleteEmailIdentity
	// enforces it); don't offer the button to plain members.
	const canDelete = isWorkspaceAdminRole(workspaceRole);

	const [identity] = await rls((tx) =>
		tx
			.select({ id: identities.id, value: identities.value })
			.from(identities)
			.where(eq(identities.publicId, identityPublicId))
			.limit(1),
	);

	return (
		<SectionCard
			title={dict.mailbox.dangerZoneTitle}
			description={dict.mailbox.dangerZoneDescription}
			footer={
				identity && canDelete ? (
					<div className="flex items-center justify-end">
						<DeleteIdentityButton
							identityId={identity.id}
							identityValue={identity.value}
							redirectTo={`/w/${workspacePublicId}/dashboard/platform/identities`}
							labels={{
								button: dict.mailbox.deleteIdentity,
								title: dict.platform.deleteIdentity,
								confirmPrefix: dict.platform.confirmDeleteIdentityPrefix,
								confirmSuffix: dict.platform.confirmDeleteIdentitySuffix,
								confirm: dict.platform.delete,
								cancel: dict.platform.cancel,
								failed: dict.platform.failedToDeleteIdentity,
							}}
						/>
					</div>
				) : null
			}
		>
			<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100">
				{dict.mailbox.deletingIdentityWarning}
			</div>
		</SectionCard>
	);
}

export default Page;
