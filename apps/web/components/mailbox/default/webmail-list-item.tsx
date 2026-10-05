"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import { Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import React from "react";
import type {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import {
	type FetchMailboxThreadsResult,
	markAsRead,
	markAsUnread,
	moveToTrash,
	toggleStar,
} from "@/lib/actions/mailbox";

import { toast } from "sonner";
import LabelRowTag from "@/components/dashboard/labels/label-row-tag";
import ThreadLabelHoverButtons from "@/components/dashboard/labels/thread-label-hover-buttons";
import SnoozeMail from "@/components/mailbox/default/snooze-mail";
import {
	getParticipantNames,
	getThreadTimeLabel,
	useIsClient,
} from "@/components/mailbox/default/thread-list-utils";

type Props = {
	mailboxThreadItem: FetchMailboxThreadsResult[number];
	activeMailbox: MailboxEntity;
	mailboxSync: MailboxSyncEntity | undefined;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	/** e.g. "/dashboard/mail/<identity>/<mailbox>/threads/" */
	threadBaseHref: string;
	isOnSnoozedPage: boolean;
	selected: boolean;
	onToggleSelect: (threadId: string, checked: boolean) => void;
};

const ACTIONS_W = "96px";

function ThreadTime({ item }: { item: FetchMailboxThreadsResult[number] }) {
	// Timezone dependent: rendered on the client only (empty during SSR and
	// hydration, as before).
	const isClient = useIsClient();
	const timeLabel = isClient
		? getThreadTimeLabel(item)
		: { text: "", className: "text-sm text-foreground", title: "" };
	return (
		<time
			className={["whitespace-nowrap", timeLabel.className].join(" ")}
			title={timeLabel.title}
			suppressHydrationWarning
		>
			{timeLabel.text}
		</time>
	);
}

// Memoized: selecting a row or toggling the list only re-renders the rows
// whose props changed instead of every row in the list.
const WebmailListItem = React.memo(function WebmailListItem({
	mailboxThreadItem,
	activeMailbox,
	mailboxSync,
	globalLabels,
	labelsByThreadId,
	threadBaseHref,
	isOnSnoozedPage,
	selected,
	onToggleSelect,
}: Props) {
	const router = useRouter();
	const [isDeleting, setIsDeleting] = React.useState(false);

	const threadHref = `${threadBaseHref}${mailboxThreadItem.threadId}`;
	const openThread = () => {
		const url = threadHref;

		// TODO: Fix full page reload on snoozed page, hoist @thread layout to higher level
		if (isOnSnoozedPage) {
			window.location.href = url;
			return;
		}
		router.push(url);
	};

	const allNames = getParticipantNames(mailboxThreadItem.participants);

	const canMarkAsRead = mailboxThreadItem.unreadCount > 0;
	const canMarkAsUnread =
		mailboxThreadItem.messageCount > 0 && mailboxThreadItem.unreadCount === 0;

	const unreadCount = Number(mailboxThreadItem.unreadCount ?? 0);
	const isUnread = unreadCount > 0;
	const isRead = unreadCount === 0;

	if (isDeleting) return null;

	// The sender/subject cells are real links: keyboard focusable, and
	// cmd/ctrl/middle-click opens the thread in a new tab natively.
	const onLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
			return;
		e.preventDefault();
		openThread();
	};

	return (
		<li
			className={[
				"relative group grid cursor-pointer has-[:focus-visible]:bg-muted/50",
				// "grid-cols-[auto_auto_minmax(16rem,1fr)_minmax(10rem,2fr)_auto]",
				"grid-cols-[auto_auto_20rem_minmax(10rem,2fr)_auto]",
				// "grid-cols-[auto_auto_minmax(8rem,12rem)_minmax(10rem,2fr)_auto]",
				"items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/50",
				isRead
					? "bg-muted/40 text-muted-foreground"
					: "bg-background font-semibold text-foreground",
				`pr-[${ACTIONS_W}]`,
			].join(" ")}
		>
			<div className="flex items-center">
				{!isOnSnoozedPage && (
					<input
						type="checkbox"
						onChange={(e) =>
							onToggleSelect(mailboxThreadItem.threadId, e.target.checked)
						}
						checked={selected}
						aria-label={`Select thread ${mailboxThreadItem.subject}`}
						className="h-4 w-4 rounded border-muted-foreground/40"
						onClick={(e) => e.stopPropagation()}
					/>
				)}
			</div>

			<button
				type="button"
				aria-label={mailboxThreadItem.starred ? "Unstar" : "Star"}
				aria-pressed={mailboxThreadItem.starred}
				className="text-muted-foreground hover:text-foreground"
				onClick={() =>
					toggleStar(
						mailboxThreadItem.threadId,
						activeMailbox.id,
						mailboxThreadItem.starred,
						!!mailboxSync,
					)
				}
			>
				{mailboxThreadItem.starred ? (
					<IconStarFilled className={"text-yellow-400"} size={12} />
				) : (
					<IconStar className="h-3 w-3" />
				)}
			</button>

			<a
				href={threadHref}
				onClick={onLinkClick}
				tabIndex={-1}
				className="flex min-w-0 items-center gap-2 truncate pr-2"
			>
				{isUnread ? (
					<span
						className="h-2 w-2 shrink-0 rounded-full bg-primary"
						title={`${unreadCount} unread`}
					/>
				) : (
					<span className="h-2 w-2 shrink-0 rounded-full bg-transparent" />
				)}
				<span className="truncate">{allNames}</span>{" "}
				{mailboxThreadItem.messageCount > 1 && (
					<span className="text-xs text-muted-foreground font-normal">
						{mailboxThreadItem.messageCount}
					</span>
				)}
			</a>

			<a
				href={threadHref}
				onClick={onLinkClick}
				className="flex min-w-0 items-center gap-1 pr-2 focus-visible:outline-none"
			>
				<LabelRowTag
					threadId={mailboxThreadItem.threadId}
					labelsByThreadId={labelsByThreadId}
					isRead={isRead}
				/>
				<span className="truncate">{mailboxThreadItem.subject}</span>
				<span className="mx-1 text-muted-foreground">–</span>
				<span className="truncate text-muted-foreground font-normal">
					{mailboxThreadItem.previewText}
				</span>
				{mailboxThreadItem.hasAttachments && (
					<Paperclip className="ml-1 hidden h-4 w-4 text-muted-foreground md:inline" />
				)}
			</a>

			<div className="ml-auto flex items-center gap-2 pl-2">
				{mailboxThreadItem.unreadCount > 0 ? (
					<Mail className="h-4 w-4 text-primary md:hidden" />
				) : (
					<MailOpen className="h-4 w-4 text-muted-foreground md:hidden" />
				)}
				<ThreadTime item={mailboxThreadItem} />
			</div>

			<div
				className={[
					"pointer-events-none absolute inset-y-0 right-3 flex items-center justify-end gap-1 bg-muted",
					`w-[${ACTIONS_W}]`,
					"opacity-0 transition-opacity duration-100",
					"group-hover:opacity-100 group-hover:pointer-events-auto px-3 rounded-l-4xl",
				].join(" ")}
				onClick={(e) => e.stopPropagation()}
			>
				<ThreadLabelHoverButtons
					mailboxThreadItem={mailboxThreadItem}
					labelsByThreadId={labelsByThreadId}
					allLabels={globalLabels}
				/>

				{canMarkAsUnread && (
					<button
						type="button"
						aria-label="Mark as unread"
						onClick={async () => {
							return await markAsUnread(
								mailboxThreadItem.threadId,
								activeMailbox.id,
								!!mailboxSync,
								true,
							);
						}}
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
						onClick={() =>
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

				<SnoozeMail
					mailboxThreadId={mailboxThreadItem.threadId}
					activeMailboxId={activeMailbox.id}
				/>

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
								{ position: "bottom-left" },
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

export default WebmailListItem;
