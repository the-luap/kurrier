"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import { Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import React from "react";
import { toast } from "sonner";
import LabelRowTag from "@/components/dashboard/labels/label-row-tag";
import {
	formatThreadDate,
	getParticipantNames,
	useIsClient,
} from "@/components/mailbox/default/thread-list-utils";
import type { FetchMailboxThreadLabelsResult } from "@/lib/actions/labels";
import {
	type FetchMailboxThreadsResult,
	markAsRead,
	markAsUnread,
	moveToTrash,
	toggleStar,
} from "@/lib/actions/mailbox";

type Props = {
	mailboxThreadItem: FetchMailboxThreadsResult[number];
	activeMailbox: MailboxEntity;
	mailboxSync: MailboxSyncEntity | undefined;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	/** e.g. "/dashboard/mail/<identity>/<mailbox>/threads/" */
	threadBaseHref: string;
	selected: boolean;
	onToggleSelect: (threadId: string, checked: boolean) => void;
};

const ACTIONS_W = 96;

// Memoized: selecting one row only re-renders that row.
const WebmailListItemMobile = React.memo(function WebmailListItemMobile({
	mailboxThreadItem,
	activeMailbox,
	mailboxSync,
	labelsByThreadId,
	threadBaseHref,
	selected,
	onToggleSelect,
}: Props) {
	const router = useRouter();
	const [isDeleting, setIsDeleting] = React.useState(false);
	// Timezone dependent: rendered on the client only (empty during SSR).
	const isClient = useIsClient();
	const dateLabel = isClient
		? formatThreadDate(mailboxThreadItem.lastActivityAt || Date.now())
		: "";

	const openThread = () => {
		router.push(`${threadBaseHref}${mailboxThreadItem.threadId}`);
	};

	const displayNames = getParticipantNames(mailboxThreadItem.participants);
	const unreadCount = Number(mailboxThreadItem.unreadCount ?? 0);
	const canMarkAsRead = unreadCount > 0;
	const canMarkAsUnread =
		mailboxThreadItem.messageCount > 0 && unreadCount === 0;
	const isRead = unreadCount === 0;

	if (isDeleting) return null;

	// The content cell is a real link (keyboard focusable, opens in a new tab
	// with modifier keys). Plain clicks bubble to the row's onClick.
	const onLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
			e.stopPropagation();
			return;
		}
		e.preventDefault();
	};

	return (
		<li
			className={[
				"relative group grid cursor-pointer has-[:focus-visible]:bg-muted/50",
				"grid-cols-[auto_1fr_auto] md:grid-cols-[auto_auto_minmax(16rem,1fr)_minmax(10rem,2fr)_auto]",
				"items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/50",
				isRead
					? "bg-muted/40 text-muted-foreground"
					: "bg-background font-semibold text-foreground",
				`md:pr-[${ACTIONS_W}px]`,
			].join(" ")}
			onClick={openThread}
		>
			{/* controls (checkbox + star) */}
			<div className="flex items-start gap-2 pt-1">
				<input
					type="checkbox"
					onClick={(e) => e.stopPropagation()}
					checked={selected}
					onChange={(e) =>
						onToggleSelect(mailboxThreadItem.threadId, e.target.checked)
					}
					aria-label={`Select ${mailboxThreadItem.subject}`}
					className="h-4 w-4 rounded border-muted-foreground/40"
				/>
				<button
					type="button"
					aria-label={mailboxThreadItem.starred ? "Unstar" : "Star"}
					aria-pressed={mailboxThreadItem.starred}
					onClick={(e) => {
						e.stopPropagation();
						toggleStar(
							mailboxThreadItem.threadId,
							activeMailbox.id,
							mailboxThreadItem.starred,
							!!mailboxSync,
						);
					}}
					className="text-muted-foreground hover:text-foreground mt-[1px]"
				>
					{mailboxThreadItem.starred ? (
						<IconStarFilled className="text-yellow-400" size={14} />
					) : (
						<IconStar className="h-3.5 w-3.5" />
					)}
				</button>
			</div>

			{/* content (2-line layout) */}
			<a
				href={`${threadBaseHref}${mailboxThreadItem.threadId}`}
				onClick={onLinkClick}
				className="min-w-0 flex flex-col focus-visible:outline-none"
			>
				<div className="flex items-center gap-2 truncate">
					{!isRead ? (
						<span
							className="h-2 w-2 shrink-0 rounded-full bg-primary"
							title={`${unreadCount} unread`}
						/>
					) : null}
					<span className="truncate">{displayNames}</span>
					{mailboxThreadItem.messageCount > 1 && (
						<span className="text-xs text-muted-foreground font-normal">
							{mailboxThreadItem.messageCount}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1 truncate text-muted-foreground font-normal text-sm">
					<LabelRowTag
						threadId={mailboxThreadItem.threadId}
						labelsByThreadId={labelsByThreadId}
						isRead={isRead}
					/>
					<span className="truncate">{mailboxThreadItem.subject}</span>
					<span className="hidden sm:inline mx-1 text-muted-foreground">–</span>
					<span className="truncate">{mailboxThreadItem.previewText}</span>
					{mailboxThreadItem.hasAttachments && (
						<Paperclip className="ml-1 h-4 w-4 text-muted-foreground hidden sm:inline" />
					)}
				</div>
			</a>

			{/* meta */}
			<div className="ml-auto flex flex-col items-end justify-start gap-1 text-right">
				<time
					className="whitespace-nowrap text-sm text-foreground"
					suppressHydrationWarning
				>
					{dateLabel}
				</time>
			</div>

			{/* hover actions */}
			<div
				className={[
					"pointer-events-none absolute inset-y-0 right-3 hidden md:flex items-center justify-end gap-1 bg-muted",
					`w-[${ACTIONS_W}px]`,
					"opacity-0 transition-opacity duration-150",
					"group-hover:opacity-100 group-hover:pointer-events-auto px-3 rounded-l-4xl",
				].join(" ")}
				onClick={(e) => e.stopPropagation()}
			>
				{canMarkAsUnread && (
					<button
						type="button"
						aria-label="Mark as unread"
						onClick={async () =>
							markAsUnread(
								mailboxThreadItem.threadId,
								activeMailbox.id,
								!!mailboxSync,
								true,
							)
						}
						className="rounded p-1 hover:bg-muted"
						title="Mark as unread"
					>
						<Mail className="h-4 w-4" />
					</button>
				)}
				{canMarkAsRead && (
					<button
						type="button"
						aria-label="Mark as read"
						onClick={async () =>
							markAsRead(
								mailboxThreadItem.threadId,
								activeMailbox.id,
								!!mailboxSync,
							)
						}
						className="rounded p-1 hover:bg-muted"
						title="Mark as read"
					>
						<MailOpen className="h-4 w-4" />
					</button>
				)}
				<button
					type="button"
					aria-label="Delete"
					onClick={async (e) => {
						e.preventDefault();
						e.stopPropagation();
						setIsDeleting(true);
						try {
							await moveToTrash(
								mailboxThreadItem.threadId,
								activeMailbox.id,
								!!mailboxSync,
								true,
							);
							toast.success("Messages moved to Trash", {
								position: "bottom-left",
							});
							router.refresh();
						} catch (error) {
							setIsDeleting(false);
							toast.error(
								error instanceof Error ? error.message : "Delete failed",
								{
									position: "bottom-left",
								},
							);
						}
					}}
					className="rounded p-1 hover:bg-muted"
					title="Delete"
				>
					<Trash2 className="h-4 w-4" />
				</button>
			</div>
		</li>
	);
});

export default WebmailListItemMobile;
