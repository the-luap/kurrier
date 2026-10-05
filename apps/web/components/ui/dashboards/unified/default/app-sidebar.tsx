"use client";

import { Divider } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { PublicConfig } from "@schema";
import type { UserResponse } from "@supabase/supabase-js";
import { IconFrame } from "@tabler/icons-react";
import { Calendar, Contact, HardDrive, Inbox, MailOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import KurrierLogo from "@/components/common/kurrier-logo";
import ThemeColorPicker from "@/components/common/theme-color-picker";
import ThemeSwitch from "@/components/common/theme-switch";
import { NavUser } from "@/components/ui/dashboards/workspace/nav-user";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import type { FetchIdentityMailboxListResult } from "@/lib/actions/mailbox";
import { cn } from "@/lib/utils";

type UnifiedSidebarProps = React.ComponentProps<typeof Sidebar> & {
	/** @deprecated unused by the sidebar; kept optional for compatibility */
	publicConfig?: PublicConfig;
	user: UserResponse["data"]["user"];
	/** @deprecated unused by the sidebar; kept optional for compatibility */
	identityMailboxes?: FetchIdentityMailboxListResult;
	sidebarSectionContent?: React.ReactNode;
	sidebarTopContent?: React.ReactNode;
};

type NavItem = {
	title: string;
	url: string;
	icon: React.ComponentType<{ className?: string }>;
	/** pathname fragment that marks this section as active */
	match: string;
};

// Static: defined once at module level so it is not recreated per render.
const NAV_MAIN: NavItem[] = [
	{ title: "All Mail", url: "/dashboard/mail", icon: Inbox, match: "/mail" },
	{
		title: "Contacts",
		url: "/dashboard/contacts",
		icon: Contact,
		match: "/contacts",
	},
	{
		title: "Calendar",
		url: "/dashboard/calendar",
		icon: Calendar,
		match: "/calendar",
	},
	{ title: "Drive", url: "/dashboard/drive", icon: HardDrive, match: "/drive" },
	{
		title: "Platform",
		url: "/dashboard/platform/overview",
		icon: IconFrame,
		match: "/platform",
	},
];

function sectionTitleForPath(pathName: string | null): string {
	// Order matters: platform wins over the others (e.g. /platform/contacts).
	for (const match of ["/platform", "/contacts", "/calendar", "/drive"]) {
		if (pathName?.includes(match)) {
			return NAV_MAIN.find((i) => i.match === match)?.title ?? "All Mail";
		}
	}
	return "All Mail";
}

export function AppSidebar({ ...props }: UnifiedSidebarProps) {
	const {
		publicConfig: _publicConfig,
		user,
		identityMailboxes: _identityMailboxes,
		sidebarSectionContent,
		sidebarTopContent,
		...restProps
	} = props;

	const isMobile = useMediaQuery("(max-width: 768px)");
	const pathName = usePathname();

	// Active item is derived from the URL. A click highlights the target
	// immediately (optimistic) until the navigation changes the pathname.
	const [pendingNav, setPendingNav] = React.useState<{
		title: string;
		fromPath: string | null;
	} | null>(null);
	const activeTitle =
		pendingNav && pendingNav.fromPath === pathName
			? pendingNav.title
			: sectionTitleForPath(pathName);

	const { setOpen, toggleSidebar } = useSidebar();

	return (
		<Sidebar
			collapsible="icon"
			{...restProps}
			style={
				{
					"--sidebar-width": "18rem",
					...restProps.style,
				} as React.CSSProperties
			}
			className="overflow-hidden *:data-[sidebar=sidebar]:flex-row"
		>
			{/* This is the first sidebar */}
			{/* We disable collapsible and adjust width to icon. */}
			{/* This will make the sidebar appear as icons. */}
			<Sidebar
				collapsible="none"
				className="w-[calc(var(--sidebar-width-icon)+1px)]! border-r bg-sidebar"
			>
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton size="lg" asChild className="md:h-8 md:p-0">
								<Link href={"/dashboard/platform/overview"}>
									<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm dark:bg-primary dark:text-primary-foreground">
										<MailOpen className="size-4" />
									</div>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">Kurrier</span>
									</div>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>
				<SidebarContent className={"relative"}>
					<SidebarGroup className={"mt-8"}>
						<SidebarGroupContent className="px-1.5 md:px-0">
							<SidebarMenu>
								{NAV_MAIN.map((item) => {
									const isActive = activeTitle === item.title;
									return (
										<SidebarMenuItem
											key={item.title}
											onClick={() => {
												if (isMobile) {
													toggleSidebar();
												}
											}}
										>
											<SidebarMenuButton
												asChild
												tooltip={{
													children: item.title,
													hidden: false,
												}}
												isActive={isActive}
												className={cn(
													"relative px-2.5 transition-colors md:px-2",
													isActive &&
														"bg-primary/10 text-sidebar-accent-foreground dark:bg-primary/20",
												)}
											>
												<Link
													href={item.url}
													onClick={() => {
														setPendingNav({
															title: item.title,
															fromPath: pathName,
														});
														setOpen(true);
													}}
												>
													{isActive ? (
														<span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
													) : null}
													<item.icon
														className={
															isActive ? "text-primary dark:text-primary" : ""
														}
													/>
													<span>{item.title}</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
									);
								})}

								{isMobile ? (
									<>
										<Divider variant={"dashed"} my={"xl"} />
										{sidebarSectionContent}
									</>
								) : (
									<hr className="my-2 border-border" />
								)}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
					<div
						className={
							isMobile
								? "absolute top-0 mx-4 flex gap-2 justify-center items-center"
								: "absolute bottom-28 rotate-90 flex justify-start items-center w-full gap-2"
						}
					>
						<ThemeColorPicker
							onComplete={() => {
								isMobile && toggleSidebar();
							}}
						/>
						<ThemeSwitch
							onComplete={() => {
								isMobile && toggleSidebar();
							}}
						/>
					</div>
				</SidebarContent>
				<SidebarFooter>
					<NavUser user={user} />
				</SidebarFooter>
			</Sidebar>

			{/* This is the second sidebar */}
			{/* We disable collapsible and let it fill remaining space */}

			<Sidebar collapsible="none" className="hidden min-w-0 flex-1 md:flex">
				<SidebarHeader className="gap-3.5 border-b p-4">
					<div className="text-left font-sans flex items-center gap-1">
						<KurrierLogo size={36} />
						<span className="text-lg font-semibold">kurrier</span>
					</div>
					{sidebarTopContent}
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup className="px-0">
						<SidebarGroupContent>{sidebarSectionContent}</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
			</Sidebar>
		</Sidebar>
	);
}
