import { SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import type { DriveState } from "@schema";
import { isSignedIn } from "@/lib/actions/auth";
import * as React from "react";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { fetchVolumes } from "@/lib/actions/drive";
import DriveSideBar from "@/components/dashboard/drive/drive-side-bar";
import NewUploadButton from "@/components/dashboard/drive/new-upload-button";

export default async function DriveLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const [user, { localVolumes, cloudVolumes }] = await Promise.all([
		isSignedIn(),
		fetchVolumes(),
	]);
	const initialState: DriveState = {
		localVolumes,
		cloudVolumes,
		driveRouteContext: null,
		userId: String(user?.id),
	};

	return (
		<>
			<DynamicContextProvider initialState={initialState}>
				<AppSidebar
					user={user}
					sidebarSectionContent={<DriveSideBar />}
					sidebarTopContent={
						<>
							<div className={"-mt-1"}>
								<NewUploadButton hideOnMobile={true} />
							</div>
						</>
					}
				/>
				<SidebarInset>{children}</SidebarInset>
			</DynamicContextProvider>
		</>
	);
}
