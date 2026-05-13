"use client";

import type {
	DraftMessageEntity,
	IdentityEntity,
	MailboxEntity,
	MailboxThreadEntity,
} from "@db";
import { Menu } from "@mantine/core";
import type { MailboxKind } from "@schema";
import { IconMailFast } from "@tabler/icons-react";
import {
	Archive,
	Ban,
	ChevronDown,
	ChevronRight,
	Clock4,
	FileText,
	Folder,
	Inbox,
	LayoutDashboard,
	MoreVertical,
	Send,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import * as React from "react";
import AddNewFolder from "@/components/mailbox/default/add-new-folder";
import DeleteMailboxFolder from "@/components/mailbox/default/delete-folder";
import type { FetchIdentityMailboxListResult } from "@/lib/actions/mailbox";
import { cn } from "@/lib/utils";

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

const ACCENT: Record<MailboxKind, string> = {
	inbox: "text-blue-600 dark:text-blue-300",
	sent: "text-emerald-600 dark:text-emerald-300",
	drafts: "text-amber-600 dark:text-amber-300",
	archive: "text-violet-600 dark:text-violet-300",
	spam: "text-rose-600 dark:text-rose-300",
	trash: "text-red-600 dark:text-red-300",
	outbox: "text-cyan-600 dark:text-cyan-300",
	custom: "text-slate-500 dark:text-slate-400",
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
	unreadThreads?: number | null;
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
			unread: Math.max(
				Number(row.unreadCount ?? 0),
				Number(row.unreadThreads ?? 0),
			),
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
				<div className="group/folder grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_1.75rem] items-center gap-1">
					{hasChildren ? (
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							className="rounded p-0.5 hover:bg-sidebar-accent/60"
							aria-label={open ? "Collapse" : "Expand"}
						>
							{open ? (
								<ChevronDown className="h-3.5 w-3.5" />
							) : (
								<ChevronRight className="h-3.5 w-3.5" />
							)}
						</button>
					) : (
						<span className="w-4" />
					)}

					<Link
						href={href}
						prefetch={false}
						onClick={onComplete ? () => onComplete() : undefined}
						aria-disabled={!m.selectable}
						style={{ paddingLeft: `${Math.min(depth, 4) * 0.625 + 0.5}rem` }}
						className={cn(
							"relative flex min-w-0 w-full items-center gap-2 rounded-md border border-transparent py-1.5 pr-2 text-sm transition-colors",
							"hover:border-sidebar-border hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground",
							isActive &&
								"border-primary/20 bg-primary/10 text-sidebar-accent-foreground shadow-sm dark:border-primary/30 dark:bg-primary/20",
							!m.selectable && "opacity-60 pointer-events-none cursor-default",
						)}
					>
						{isActive ? (
							<span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
						) : null}
						<Icon className={cn("h-4 w-4 shrink-0", ACCENT[m.kind])} />
						<span
							className="min-w-0 flex-1 truncate"
							title={
								m.kind === "custom" ? (m.name ?? "Mailbox") : TITLE[m.kind]
							}
						>
							{m.kind === "custom" ? (m.name ?? "Mailbox") : TITLE[m.kind]}
						</span>
						{(m.kind === "inbox" || m.unread > 0) && (
							<span
								className={cn(
									"ml-auto shrink-0 rounded-full border px-1.5 text-[10px] leading-5 tabular-nums",
									m.unread > 0
										? "border-primary/20 bg-primary/10 text-sidebar-foreground dark:border-primary/30 dark:bg-primary/20"
										: "border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground/60",
								)}
								title={`${m.unread} unread`}
							>
								{m.unread > 99 ? "99+" : m.unread}
							</span>
						)}
					</Link>

					{m.kind === "custom" ? (
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
					) : (
						<span className="h-7 w-7" />
					)}
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
					"mb-3 flex min-w-0 items-center gap-2 rounded-md border border-transparent px-2 py-2 text-sm font-medium transition-colors",
					"hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
					pathname === "/dashboard/mail" &&
						"border-primary/20 bg-primary/10 text-sidebar-accent-foreground dark:border-primary/30 dark:bg-primary/20",
				)}
			>
				<LayoutDashboard className="h-4 w-4 shrink-0 text-primary" />
				<span className="min-w-0 truncate">Mailbox Overview</span>
			</Link>
			{identityMailboxes.map(({ identity, mailboxes }) => {
				const tree = buildTree(mailboxes as MailboxEntity[]);
				const identityUnread = tree.reduce(
					(sum, mailbox) =>
						sum + (mailbox.kind === "inbox" ? mailbox.unread : 0),
					0,
				);

				const scheduledCounts = scheduledDrafts.filter(
					(draft) => draft.identityId === identity.id,
				).length;
				const snoozedCounts = snoozedThreads.filter(
					(snoozed) => snoozed.identityId === identity.id,
				).length;
				return (
					<div key={identity.id} className="min-w-0">
						<div className="mb-1 mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 border-l-2 border-l-primary/30 px-2 text-xs font-semibold text-sidebar-foreground/60 dark:border-l-primary/50">
							<span className="min-w-0 flex-1 truncate" title={identity.value}>
								{identity.value}
							</span>
							{identityUnread > 0 ? (
								<span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] leading-5 text-sidebar-foreground tabular-nums dark:bg-primary/20">
									{identityUnread > 99 ? "99+" : identityUnread}
								</span>
							) : null}
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
								className={cn(
									"my-2 flex w-full justify-start gap-1 rounded border border-transparent p-1.5 text-sm transition-colors hover:bg-sidebar-accent/80",
									currentSlug === "scheduled" &&
										"border-primary/20 bg-primary/10 text-sidebar-accent-foreground dark:border-primary/30 dark:bg-primary/20",
								)}
							>
								<IconMailFast
									size={22}
									className="text-cyan-600 dark:text-cyan-300"
								/>
								<span className={"font-normal text-sm"}>
									Scheduled ({scheduledCounts})
								</span>
							</Link>
						)}

						{snoozedCounts > 0 && (
							<Link
								href={`/dashboard/mail/${params.identityPublicId}/snoozed`}
								prefetch={false}
								className={cn(
									"my-2 flex w-full items-center justify-start gap-1 rounded border border-transparent p-1.5 text-sm transition-colors hover:bg-sidebar-accent/80",
									currentSlug === "snoozed" &&
										"border-primary/20 bg-primary/10 text-sidebar-accent-foreground dark:border-primary/30 dark:bg-primary/20",
								)}
							>
								<Clock4
									size={16}
									className="text-violet-600 dark:text-violet-300"
								/>
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
