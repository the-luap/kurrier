"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
	Inbox,
	Send,
	FileText,
	Archive,
	Ban,
	Trash2,
	Folder,
	ChevronRight,
	ChevronDown,
	MoreVertical,
	Clock4,
	LayoutDashboard,
} from "lucide-react";
import * as React from "react";
import type { FetchIdentityMailboxListResult } from "@/lib/actions/mailbox";
import type { MailboxKind } from "@schema";
import type {
	DraftMessageEntity,
	IdentityEntity,
	MailboxEntity,
	MailboxThreadEntity,
} from "@db";
import AddNewFolder from "@/components/mailbox/default/add-new-folder";
import { Menu } from "@mantine/core";
import DeleteMailboxFolder from "@/components/mailbox/default/delete-folder";
import { IconMailFast } from "@tabler/icons-react";

const ORDER: MailboxKind[] = [
	"inbox",
	"drafts",
	"sent",
	"archive",
	"spam",
	"trash",
	"outbox",
	"custom",
];

const ICON: Record<MailboxKind, React.ElementType> = {
	inbox: Inbox,
	sent: Send,
	drafts: FileText,
	archive: Archive,
	spam: Ban,
	trash: Trash2,
	outbox: Send,
	custom: Folder,
};

const TITLE: Record<MailboxKind, string> = {
	inbox: "Inbox",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	spam: "Spam",
	trash: "Trash",
	outbox: "Outbox",
	custom: "Mailbox",
};

type TreeMailbox = {
	id: string;
	name: string | null;
	kind: MailboxKind;
	slug: string | null;
	parentId: string | null;
	selectable: boolean;
	unread: number;
	children: TreeMailbox[];
};

type MailboxWithNavMeta = MailboxEntity & {
	parentId?: string | null;
	unreadCount?: number | null;
	metaData?: { imap?: { selectable?: boolean } } | null;
};

function buildTree(rows: MailboxEntity[]): TreeMailbox[] {
	const byId = new Map<string, TreeMailbox>();
	const roots: TreeMailbox[] = [];

	for (const r of rows) {
		const row = r as MailboxWithNavMeta;
		byId.set(r.id, {
			id: r.id,
			name: r.name ?? null,
			kind: r.kind as MailboxKind,
			slug: r.slug ?? null,
			parentId: row.parentId ?? null,
			selectable: row.metaData?.imap?.selectable !== false,
			unread: Number(row.unreadCount ?? 0),
			children: [],
		});
	}

	for (const node of byId.values()) {
		if (node.parentId && byId.has(node.parentId)) {
			byId.get(node.parentId)?.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const sortRec = (arr: TreeMailbox[]) => {
		arr.sort(
			(a, b) =>
				(ORDER.indexOf(a.kind) ?? 999) - (ORDER.indexOf(b.kind) ?? 999) ||
				(a.name ?? "").localeCompare(b.name ?? ""),
		);
		for (const c of arr) if (c.children.length) sortRec(c.children);
	};
	sortRec(roots);

	return roots;
}

export default function IdentityMailboxesList({
	identityMailboxes,
	scheduledDrafts,
	snoozedThreads,
	onComplete,
}: {
	identityMailboxes: FetchIdentityMailboxListResult;
	scheduledDrafts: DraftMessageEntity[];
	snoozedThreads: MailboxThreadEntity[];
	onComplete?: () => void;
}) {
	const pathname = usePathname();
	const params = useParams() as {
		identityPublicId?: string;
		mailboxSlug?: string;
	};
	const currentSlug = React.useMemo(() => {
		const parts = pathname.split("/").filter(Boolean);
		return parts.at(-1) ?? "inbox";
	}, [pathname]);

	const Item = ({
		m,
		identityPublicId,
		depth = 0,
		identity,
	}: {
		m: TreeMailbox;
		identityPublicId: string;
		depth?: number;
		identity: IdentityEntity;
	}) => {
		const Icon = ICON[m.kind] ?? Folder;
		const slug = m.slug ?? "inbox";
		const href = `/dashboard/mail/${identityPublicId}/${slug}`;
		const isActive =
			pathname === href ||
			(params.identityPublicId === identityPublicId && currentSlug === slug);

		const [open, setOpen] = React.useState(true);
		const hasChildren = m.children.length > 0;

		return (
			<div className="min-w-0">
				<div className="flex min-w-0 items-center">
					{hasChildren ? (
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							className="mr-1 shrink-0 rounded p-0.5 hover:bg-sidebar-accent/60"
							aria-label={open ? "Collapse" : "Expand"}
						>
							{open ? (
								<ChevronDown className="h-3.5 w-3.5" />
							) : (
								<ChevronRight className="h-3.5 w-3.5" />
							)}
						</button>
					) : (
						<span className="w-4 shrink-0" />
					)}

					<div className="flex min-w-0 flex-1 items-center gap-1">
						<Link
							href={href}
							prefetch={false}
							onClick={onComplete ? () => onComplete() : undefined}
							aria-disabled={!m.selectable}
							style={{ paddingLeft: `${Math.min(depth, 4) * 0.625 + 0.5}rem` }}
							className={cn(
								"flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-sm",
								"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
								isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
								isActive
									? "text-brand dark:text-white bg-brand-100 dark:bg-neutral-800 hover:text-brand hover:bg-brand-100"
									: "",
								!m.selectable &&
									"opacity-60 pointer-events-none cursor-default",
							)}
						>
							<Icon className="h-4 w-4 shrink-0" />
							<span
								className="min-w-0 flex-1 truncate"
								title={
									m.kind === "custom" ? (m.name ?? "Mailbox") : TITLE[m.kind]
								}
							>
								{m.kind === "custom" ? (m.name ?? "Mailbox") : TITLE[m.kind]}
							</span>
							{m.unread > 0 && (
								<span className="ml-auto shrink-0 rounded-full border px-1.5 text-[10px] leading-5 text-sidebar-foreground/80">
									{m.unread > 99 ? "99+" : m.unread}
								</span>
							)}
						</Link>

						{m.kind === "custom" && (
							<Menu withinPortal position="right-start" offset={4}>
								<Menu.Target>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation(); // don’t toggle parent handlers
										}}
										className={cn(
											"shrink-0 rounded p-1 transition",
											"hover:bg-sidebar-accent/60",
										)}
										aria-label={`Actions for ${m.name ?? "folder"}`}
									>
										<MoreVertical className="h-4 w-4" />
									</button>
								</Menu.Target>
								<Menu.Dropdown onClick={(e) => e.stopPropagation()}>
									<DeleteMailboxFolder
										mailboxId={m.id}
										identityPublicId={identityPublicId}
										imapOp={!!identity.smtpAccountId}
									/>
								</Menu.Dropdown>
							</Menu>
						)}
					</div>
				</div>

				{open && hasChildren && (
					<div className="min-w-0">
						{m.children.map((child) => (
							<Item
								key={child.id}
								m={child}
								identityPublicId={identityPublicId}
								identity={identity}
								depth={depth + 1}
							/>
						))}
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="min-w-0 space-y-2 overflow-x-hidden px-2">
			<Link
				href="/dashboard/mail"
				prefetch={false}
				onClick={onComplete ? () => onComplete() : undefined}
				className={cn(
					"mb-3 flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-sm font-medium",
					"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
					pathname === "/dashboard/mail" &&
						"bg-sidebar-accent text-sidebar-accent-foreground",
				)}
			>
				<LayoutDashboard className="h-4 w-4 shrink-0" />
				<span className="min-w-0 truncate">Mailbox Overview</span>
			</Link>
			{identityMailboxes.map(({ identity, mailboxes }) => {
				const tree = buildTree(mailboxes as MailboxEntity[]);

				const scheduledCounts = scheduledDrafts.filter(
					(draft) => draft.identityId === identity.id,
				).length;
				const snoozedCounts = snoozedThreads.filter(
					(snoozed) => snoozed.identityId === identity.id,
				).length;
				return (
					<div key={identity.id} className="min-w-0">
						<div className="mb-1 mt-2 flex min-w-0 items-center gap-1 px-1 text-xs font-semibold text-sidebar-foreground/60">
							<span className="min-w-0 flex-1 truncate" title={identity.value}>
								{identity.value}
							</span>
							<AddNewFolder mailboxes={mailboxes} identity={identity} />
						</div>
						<div className="min-w-0 space-y-1">
							{tree.map((m) => (
								<Item
									key={`${identity.id}:${m.id}`}
									m={m}
									identityPublicId={identity.publicId}
									identity={identity}
								/>
							))}
						</div>
						{scheduledCounts > 0 && (
							<Link
								href={`/dashboard/mail/${params.identityPublicId}/scheduled`}
								prefetch={false}
								className={`my-2 rounded hover:dark:bg-neutral-800 ${currentSlug === "scheduled" ? "dark:bg-neutral-800 dark:text-brand-foreground bg-brand-200 text-brand" : ""} flex justify-start gap-1 w-full p-1.5`}
							>
								<IconMailFast size={22} />
								<span className={"font-normal text-sm"}>
									Scheduled ({scheduledCounts})
								</span>
							</Link>
						)}

						{snoozedCounts > 0 && (
							<Link
								href={`/dashboard/mail/${params.identityPublicId}/snoozed`}
								prefetch={false}
								className={`my-2 rounded hover:dark:bg-neutral-800 ${currentSlug === "snoozed" ? "dark:bg-neutral-800 dark:text-brand-foreground bg-brand-200 text-brand" : ""} flex justify-start gap-1 w-full p-1.5 items-center`}
							>
								<Clock4 size={16} />
								<span className={"font-normal text-sm"}>
									Snoozed ({snoozedThreads.length})
								</span>
							</Link>
						)}
					</div>
				);
			})}
		</div>
	);
}
