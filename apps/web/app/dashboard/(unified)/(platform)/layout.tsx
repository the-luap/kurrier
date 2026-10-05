import { SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import { isSignedIn } from "@/lib/actions/auth";
import { NavMain } from "@/components/nav-main";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await isSignedIn();

	return (
		<>
			<AppSidebar user={user} sidebarSectionContent={<NavMain />} />
			<SidebarInset>{children}</SidebarInset>
		</>
	);
}
