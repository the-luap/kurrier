import { SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import { fetchContactLabelsWithCounts } from "@/lib/actions/labels";
import type { LabelScope } from "@schema";
import { isSignedIn } from "@/lib/actions/auth";
import ContactsNav from "@/components/dashboard/contacts/contacts-sidebar";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import LabelHome from "@/components/dashboard/labels/label-home";
import * as React from "react";
import NewContactButton from "@/components/dashboard/contacts/new-contact-button";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const [user, contactLabels] = await Promise.all([
		isSignedIn(),
		fetchContactLabelsWithCounts(),
	]);

	return (
		<>
			<AppSidebar
				user={user}
				sidebarTopContent={
					<>
						<div className={"-mt-1"}>
							<NewContactButton hideOnMobile={true} />
						</div>
					</>
				}
				sidebarSectionContent={
					<>
						<ContactsNav />
						<DynamicContextProvider
							initialState={{
								labels: contactLabels,
								scope: "contact" as LabelScope,
							}}
						>
							<LabelHome />
						</DynamicContextProvider>
					</>
				}
			/>
			<SidebarInset>{children}</SidebarInset>
		</>
	);
}
