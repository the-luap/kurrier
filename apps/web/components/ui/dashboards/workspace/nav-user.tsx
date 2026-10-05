"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import { UserResponse } from "@supabase/supabase-js";
import { Avatar as MantineAvatar } from "@mantine/core";
import { getGravatarUrl, signOut } from "@/lib/actions/auth";
import { useEffect, useState } from "react";

// Every dashboard section mounts its own sidebar, so cache the resolved URL
// per email for the lifetime of the tab instead of calling the server action
// on every section switch / router.refresh().
const gravatarCache = new Map<string, string>();

export function NavUser({ user }: { user: UserResponse["data"]["user"] }) {
	const { isMobile } = useSidebar();
	const email = user?.email;
	const [gravatarUrl, setGravatarUrl] = useState<string | null>(
		() => (email && gravatarCache.get(email)) || null,
	);

	useEffect(() => {
		if (!email) return;
		const cached = gravatarCache.get(email);
		if (cached) {
			setGravatarUrl(cached);
			return;
		}
		let cancelled = false;
		getGravatarUrl(email).then((avatar) => {
			gravatarCache.set(email, avatar);
			if (!cancelled) setGravatarUrl(avatar);
		});
		return () => {
			cancelled = true;
		};
	}, [email]);

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground md:h-8 md:p-0"
						>
							<Avatar className="h-8 w-8 rounded-lg">
								{gravatarUrl && (
									<AvatarImage src={gravatarUrl} alt={user?.email} />
								)}
								<AvatarFallback className="rounded-lg">K</AvatarFallback>
							</Avatar>
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">{user?.email}</span>
								<span className="truncate text-xs">{user?.email}</span>
							</div>
							<ChevronsUpDown className="ml-auto size-4" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
						side={isMobile ? "bottom" : "right"}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuLabel className="p-0 font-normal">
							<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
								<Avatar className="h-8 w-8 rounded-lg">
									{gravatarUrl && (
										<AvatarImage src={gravatarUrl} alt={user?.email} />
									)}
									<MantineAvatar name={user?.email} color="initials" />
								</Avatar>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-medium">{user?.email}</span>
									<span className="truncate text-xs">{user?.email}</span>
								</div>
							</div>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => signOut()}
							className={"cursor-pointer"}
						>
							<LogOut />
							Log out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
