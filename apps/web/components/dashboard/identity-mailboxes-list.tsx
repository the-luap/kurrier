"use client";

import type { IdentityEntity, MailboxEntity } from "@db";
import { Menu, Select } from "@mantine/core";
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
import { useParams, usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { Suspense, use, useEffect } from "react";
import AddNewFolder from "@/components/mailbox/default/add-new-folder";
import DeleteMailboxFolder from "@/components/mailbox/default/delete-folder";
import {
	useOptionalDictionary,
	useOptionalI18n,
} from "@/components/providers/dictionary-provider";
import { useSidebar } from "@/components/ui/sidebar";
import type {
	FetchIdentityMailboxListResult,
	FetchMailboxUnreadCountsResult,
	FetchMailSidebarCountsResult,
} from "@/lib/actions/mailbox";
import type { Dictionary } from "@/lib/dictionaries";
import { cn, setSidebarWidth } from "@/lib/utils";

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

type MailboxDict = Dictionary["mailbox"] | null | undefined;

function mailboxTitle(kind: MailboxKind, dict: MailboxDict): string {
	switch (kind) {
		case "inbox":
			return dict?.folderInbox ?? "Inbox";
		case "sent":
			return dict?.folderSent ?? "Sent";
		case "drafts":
			return dict?.folderDrafts ?? "Drafts";
		case "archive":
			return dict?.folderArchive ?? "Archive";
		case "spam":
			return dict?.folderSpam ?? "Spam";
		case "trash":
			return dict?.folderTrash ?? "Trash";
		case "outbox":
			return dict?.folderOutbox ?? "Outbox";
		default:
			return dict?.folderMailbox ?? "Mailbox";
	}
}

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

const formatBadge = (count: number) => (count > 99 ? "99+" : String(count));

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

function orderIndex(kind: MailboxKind) {
	const idx = ORDER.indexOf(kind);
	return idx === -1 ? 999 : idx;
}

function buildTree(
	rows: MailboxEntity[],
	unreadCounts: FetchMailboxUnreadCountsResult,
): TreeMailbox[] {
	const byId = new Map<string, TreeMailbox>();
	const roots: TreeMailbox[] = [];

	for (const r of rows) {
		byId.set(r.id, {
			id: r.id,
			name: r.name ?? null,
			kind: r.kind as MailboxKind,
			slug: r.slug ?? null,
			parentId: r.parentId ?? null,
			selectable:
				(r.metaData as { imap?: { selectable?: boolean } } | null)?.imap
					?.selectable !== false,
			// Badge = threads with unread mail; unreadTotal counts every unread
			// message and overcounts long threads.
			unread: unreadCounts.get(r.id)?.unreadThreads ?? 0,
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
				orderIndex(a.kind) - orderIndex(b.kind) ||
				(a.name ?? "").localeCompare(b.name ?? ""),
		);
		for (const c of arr) if (c.children.length) sortRec(c.children);
	};
	sortRec(roots);

	return roots;
}

function IdentityExtraCounts({
	identity,
	sidebarCountsPromise,
	workspacePublicId,
	currentSlug,
	isActiveIdentity,
	onNavigate,
}: {
	identity: IdentityEntity;
	sidebarCountsPromise: Promise<FetchMailSidebarCountsResult>;
	workspacePublicId: string | undefined;
	currentSlug: string | undefined;
	isActiveIdentity: boolean;
	onNavigate?: () => void;
}) {
	const { scheduledByIdentityId, snoozedByIdentityId, draftsByIdentityId } =
		use(sidebarCountsPromise);
	const scheduledCount = scheduledByIdentityId[identity.id] ?? 0;
	const snoozedCount = snoozedByIdentityId[identity.id] ?? 0;
	const draftsCount = draftsByIdentityId[identity.id] ?? 0;

	const dict = useOptionalDictionary();

	return (
		<>
			{draftsCount > 0 && (
				<ExtraLink
					href={`/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/unsent`}
					active={isActiveIdentity && currentSlug === "unsent"}
					icon={<FileText size={16} className="shrink-0 text-amber-600 dark:text-amber-300" />}
					label={dict?.mailbox?.folderDrafts ?? "Drafts"}
					count={draftsCount}
					onNavigate={onNavigate}
				/>
			)}

			{scheduledCount > 0 && (
				<ExtraLink
					href={`/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/scheduled`}
					active={isActiveIdentity && currentSlug === "scheduled"}
					icon={<IconMailFast size={16} className="shrink-0 text-cyan-600 dark:text-cyan-300" />}
					label={dict?.mailbox?.scheduled ?? "Scheduled"}
					count={scheduledCount}
					onNavigate={onNavigate}
				/>
			)}

			{snoozedCount > 0 && (
				<ExtraLink
					href={`/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/snoozed`}
					active={isActiveIdentity && currentSlug === "snoozed"}
					icon={<Clock4 size={16} className="shrink-0 text-orange-500 dark:text-orange-300" />}
					label={dict?.mailbox?.snoozed ?? "Snoozed"}
					count={snoozedCount}
					onNavigate={onNavigate}
				/>
			)}
		</>
	);
}

function ExtraLink({
	href,
	active,
	icon,
	label,
	count,
	onNavigate,
}: {
	href: string;
	active: boolean;
	icon: React.ReactNode;
	label: string;
	count: number;
	onNavigate?: () => void;
}) {
	return (
		<Link
			href={href}
			prefetch={false}
			onClick={onNavigate}
			className={cn(
				"relative mt-1 ml-7 flex min-w-0 items-center gap-2 rounded-md border border-transparent py-1.5 pr-2 pl-2 text-sm transition-colors",
				"hover:border-sidebar-border hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground",
				active &&
					"border-primary/20 bg-primary/10 text-sidebar-accent-foreground shadow-sm dark:border-primary/30 dark:bg-primary/20",
			)}
		>
			{active ? (
				<span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
			) : null}
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span className="ml-auto shrink-0 rounded-full border border-sidebar-border bg-sidebar-accent/40 px-1.5 text-[10px] leading-5 text-sidebar-foreground/70 tabular-nums">
				{formatBadge(count)}
			</span>
		</Link>
	);
}

// Module scope (not defined inside the list) so React keeps the same
// component type across renders and the folder tree (and its collapsed
// state) does not remount on navigation. Memoized and only given the active
// slug of *its own* identity, so navigating re-renders just the folders
// whose active state changes.
const MailboxItem = React.memo(function MailboxItem({
	m,
	identityPublicId,
	identity,
	workspacePublicId,
	level = 0,
	activeSlug,
	onNavigate,
}: {
	m: TreeMailbox;
	identityPublicId: string;
	identity: IdentityEntity;
	workspacePublicId: string | undefined;
	level?: number;
	/** Active mailbox slug when this identity is the active one. */
	activeSlug?: string;
	onNavigate?: () => void;
}) {
	const dict = useOptionalDictionary();
	const format = useOptionalI18n()?.format;
	const Icon = ICON[m.kind] ?? Folder;
	const slug = m.slug ?? "inbox";
	const itemLabel =
		m.kind === "custom"
			? (m.name ?? mailboxTitle("custom", dict?.mailbox))
			: mailboxTitle(m.kind, dict?.mailbox);
	const href = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${slug}`;
	const isActive = activeSlug === slug;

	const [open, setOpen] = React.useState(true);
	const hasChildren = m.children.length > 0;
	const unreadTitle =
		format?.message(
			m.unread,
			dict?.mailbox?.unreadThreadsCount ?? { other: "{count} unread" },
		) ?? `${m.unread} unread`;

	return (
		<div className="min-w-0">
			<div className="flex min-w-0 items-center gap-1">
				{hasChildren ? (
					<button
						type="button"
						onClick={() => setOpen((v) => !v)}
						className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-sidebar-accent/60"
						aria-label={
							open
								? (dict?.mailbox?.collapseFolder ?? "Collapse")
								: (dict?.mailbox?.expandFolder ?? "Expand")
						}
						aria-expanded={open}
					>
						{open ? (
							<ChevronDown className="h-3.5 w-3.5" />
						) : (
							<ChevronRight className="h-3.5 w-3.5" />
						)}
					</button>
				) : (
					<span className="w-6 shrink-0" />
				)}

				<div className="flex min-w-0 flex-1 items-start gap-1">
					<Link
						href={href}
						prefetch={false}
						title={itemLabel}
						onClick={onNavigate}
						aria-disabled={!m.selectable}
						aria-current={isActive ? "page" : undefined}
						className={cn(
							"relative flex min-w-0 flex-1 items-center gap-2 rounded-md border border-transparent py-1.5 pr-2 text-sm transition-colors",
							"hover:border-sidebar-border hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground",
							isActive &&
								"border-primary/20 bg-primary/10 text-sidebar-accent-foreground shadow-sm dark:border-primary/30 dark:bg-primary/20",
							!m.selectable && "opacity-60 pointer-events-none cursor-default",
						)}
						style={{ paddingLeft: 8 + Math.min(level, 4) * 8 }}
					>
						{isActive ? (
							<span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
						) : null}
						<Icon className={cn("h-4 w-4 shrink-0", ACCENT[m.kind])} />
						<span className="min-w-0 flex-1 truncate">{itemLabel}</span>
						{(m.kind === "inbox" || m.unread > 0) && (
							<span
								className={cn(
									"ml-auto shrink-0 rounded-full border px-1.5 text-[10px] leading-5 tabular-nums",
									m.unread > 0
										? "border-primary/20 bg-primary/10 text-sidebar-foreground dark:border-primary/30 dark:bg-primary/20"
										: "border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground/60",
								)}
								title={unreadTitle}
							>
								{formatBadge(m.unread)}
							</span>
						)}
					</Link>

					{m.kind === "custom" && (
						<Menu withinPortal position="right-start" offset={4}>
							<Menu.Target>
								<button
									type="button"
									onClick={(e) => e.stopPropagation()}
									className={cn(
										"mt-1 flex size-7 shrink-0 items-center justify-center rounded transition",
										"hover:bg-sidebar-accent/60",
									)}
									aria-label={`${dict?.mailbox?.folderActionsPrefix ?? "Actions for "}${m.name ?? ""}`}
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
				<div>
					{m.children.map((child) => (
						<MailboxItem
							key={child.id}
							m={child}
							identityPublicId={identityPublicId}
							identity={identity}
							workspacePublicId={workspacePublicId}
							level={level + 1}
							activeSlug={activeSlug}
							onNavigate={onNavigate}
						/>
					))}
				</div>
			)}
		</div>
	);
});

export default function IdentityMailboxesList({
	identityMailboxes,
	unreadCounts,
	sidebarCountsPromise,
	workspacePublicId,
	onComplete,
}: {
	identityMailboxes: FetchIdentityMailboxListResult;
	unreadCounts: FetchMailboxUnreadCountsResult;
	sidebarCountsPromise: Promise<FetchMailSidebarCountsResult>;
	workspacePublicId: string | undefined;
	onComplete?: () => void;
}) {
	const dict = useOptionalDictionary();
	const pathname = usePathname();
	const params = useParams() as {
		identityPublicId?: string;
		mailboxSlug?: string;
	};

	useEffect(() => {
		setSidebarWidth("340px");
		return () => setSidebarWidth("250px");
	}, []);

	// /mail/<identity>/<mailboxSlug | scheduled | snoozed>/…: use the route
	// param (not the last segment) so thread pages such as
	// /…/inbox/threads/<id> still highlight their mailbox.
	const currentSlug = React.useMemo(() => {
		if (params.mailboxSlug) return params.mailboxSlug;
		const parts = pathname.split("/").filter(Boolean);
		const mailIndex = parts.indexOf("mail");
		return mailIndex === -1 ? undefined : parts[mailIndex + 2];
	}, [params.mailboxSlug, pathname]);

	const router = useRouter();

	// On mobile the list lives in the sidebar sheet: close it after a click,
	// even when the link points at the current page (no pathname change).
	const { isMobile, setOpenMobile } = useSidebar();
	const handleNavigate = React.useCallback(() => {
		onComplete?.();
		if (isMobile) setOpenMobile(false);
	}, [onComplete, isMobile, setOpenMobile]);

	const overviewHref = `/w/${workspacePublicId}/dashboard/mail`;
	const isOverviewActive = pathname.replace(/\/+$/, "").endsWith("/dashboard/mail");

	const identityNav = React.useMemo(
		() =>
			identityMailboxes.map(({ identity, mailboxes }) => {
				const tree = buildTree(mailboxes as MailboxEntity[], unreadCounts);
				return {
					identity,
					mailboxes,
					tree,
					inboxUnread: tree.reduce(
						(sum, mailbox) =>
							sum + (mailbox.kind === "inbox" ? mailbox.unread : 0),
						0,
					),
				};
			}),
		[identityMailboxes, unreadCounts],
	);

	return (
		<div className="min-w-0 space-y-2 px-3 pb-4">
			<Link
				href={overviewHref}
				prefetch={false}
				onClick={handleNavigate}
				aria-current={isOverviewActive ? "page" : undefined}
				className={cn(
					"relative mt-2 flex min-w-0 items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm font-medium transition-colors",
					"hover:border-sidebar-border hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground",
					isOverviewActive &&
						"border-primary/20 bg-primary/10 text-sidebar-accent-foreground shadow-sm dark:border-primary/30 dark:bg-primary/20",
				)}
			>
				{isOverviewActive ? (
					<span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
				) : null}
				<LayoutDashboard className="h-4 w-4 shrink-0 text-primary" />
				<span className="min-w-0 truncate">
					{dict?.mailbox?.overviewNav ?? "Overview"}
				</span>
			</Link>

			<div className="my-2 min-w-0">
				<Select
					className="min-w-0"
					placeholder={dict?.common?.pickValue ?? "Pick value"}
					size="sm"
					allowDeselect={false}
					withCheckIcon={false}
					styles={{
						input: {
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						},
					}}
					onChange={(publicId) => {
						handleNavigate();
						router.push(
							`/w/${workspacePublicId}/dashboard/mail/${publicId}/inbox`,
						);
					}}
					// null (not undefined) keeps the Select controlled on the overview.
					value={params.identityPublicId ?? null}
					data={identityMailboxes.map((id) => {
						return { value: id.identity.publicId, label: id.identity.value };
					})}
				/>
			</div>

			{identityNav.map(({ identity, mailboxes, tree, inboxUnread }) => {
				const isActiveIdentity = params.identityPublicId === identity.publicId;
				const activeSlug = isActiveIdentity ? currentSlug : undefined;

				return (
					<div key={identity.id} className="min-w-0">
						<div className="mb-1 mt-3 flex min-w-0 items-center gap-2 border-l-2 border-l-primary/30 px-2 text-xs font-semibold text-sidebar-foreground/60 dark:border-l-primary/50">
							<span className="min-w-0 flex-1 truncate" title={identity.value}>
								{identity.value}
							</span>
							{inboxUnread > 0 && (
								<span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] leading-5 text-sidebar-foreground tabular-nums dark:bg-primary/20">
									{formatBadge(inboxUnread)}
								</span>
							)}
							<AddNewFolder mailboxes={mailboxes} identity={identity} />
						</div>

						<div className="space-y-1">
							{tree.map((m) => (
								<MailboxItem
									key={`${identity.id}:${m.id}`}
									m={m}
									identityPublicId={identity.publicId}
									identity={identity}
									workspacePublicId={workspacePublicId}
									activeSlug={activeSlug}
									onNavigate={handleNavigate}
								/>
							))}
						</div>

						<Suspense fallback={null}>
							<IdentityExtraCounts
								identity={identity}
								sidebarCountsPromise={sidebarCountsPromise}
								workspacePublicId={workspacePublicId}
								currentSlug={currentSlug}
								isActiveIdentity={isActiveIdentity}
								onNavigate={handleNavigate}
							/>
						</Suspense>
					</div>
				);
			})}
		</div>
	);
}
