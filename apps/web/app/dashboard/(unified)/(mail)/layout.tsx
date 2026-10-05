import { getPublicEnv, type LabelScope } from "@schema";
import type * as React from "react";
import IdentityMailboxesList from "@/components/dashboard/identity-mailboxes-list";
import LabelHome from "@/components/dashboard/labels/label-home";
import ComposeMail from "@/components/mailbox/default/compose-mail";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { isSignedIn } from "@/lib/actions/auth";
import { fetchLabelsWithCounts } from "@/lib/actions/labels";
import {
	fetchIdentityMailboxList,
	fetchIdentitySnoozedThreads,
	fetchScheduledDraftCounts,
} from "@/lib/actions/mailbox";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const publicConfig = getPublicEnv();
	const [
		identityMailboxes,
		user,
		globalLabels,
		scheduledDrafts,
		{ threads: snoozedThreads },
	] = await Promise.all([
		fetchIdentityMailboxList(),
		isSignedIn(),
		fetchLabelsWithCounts(),
		fetchScheduledDraftCounts(),
		fetchIdentitySnoozedThreads(),
	]);

	return (
		<>
			<AppSidebar
				user={user}
				sidebarTopContent={
					<div className={"-mt-1"} key={"mail-sidebar-compose"}>
						{identityMailboxes.length > 0 && (
							<ComposeMail
								publicConfig={publicConfig}
								identityMailboxes={identityMailboxes}
							/>
						)}
					</div>
				}
				sidebarSectionContent={
					<>
						<IdentityMailboxesList
							identityMailboxes={identityMailboxes}
							scheduledDrafts={scheduledDrafts}
							snoozedThreads={snoozedThreads}
						/>
						<DynamicContextProvider
							initialState={{
								labels: globalLabels,
								scope: "thread" as LabelScope,
							}}
						>
							{identityMailboxes.length > 0 && <LabelHome />}
						</DynamicContextProvider>
					</>
				}
			/>
			<SidebarInset>{children}</SidebarInset>
		</>
	);
}
