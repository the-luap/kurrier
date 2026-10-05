"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import { Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { toast } from "sonner";
import LabelRowTag from "@/components/dashboard/labels/label-row-tag";
import ThreadLabelHoverButtons from "@/components/dashboard/labels/thread-label-hover-buttons";
import SnoozeMail from "@/components/mailbox/default/snooze-mail";
import {
	getParticipantNames,
	getThreadTimeLabel,
	useIsClient,
} from "@/components/mailbox/default/thread-list-utils";
import { useOptionalDictionary } from "@/components/providers/dictionary-provider";
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

type ThreadRow = FetchMailboxThreadsResult[number];

type Props = {
	mailboxThreadItem: ThreadRow;
	activeMailbox: MailboxEntity;
	mailboxSync: MailboxSyncEntity | undefined;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	/** e.g. "/w/<ws>/dashboard/mail/<identity>/<mailbox>/threads/" */
	threadBaseHref: string;
	isOnSnoozedPage: boolean;
	selected: boolean;
	onToggleSelect: (threadId: string, checked: boolean) => void;
};

function ThreadTime({ item }: { item: ThreadRow }) {
	const dict = useOptionalDictionary();
	// Timezone dependent: rendered on the client only (empty during SSR and
	// hydration) so server and browser timezones never disagree.
	const isClient = useIsClient();
	const timeLabel = isClient
		? getThreadTimeLabel(item, dict?.mailbox, dict?.locale)
		: { text: "", className: "text-sm text-foreground", title: "" };
	return (
		<time
			className={["whitespace-nowrap", timeLabel.className].join(" ")}
			title={timeLabel.title || undefined}
			suppressHydrationWarning
		>
			{timeLabel.text}
		</time>
	);
}

// Memoized: selecting a row only re-renders the rows whose props changed
// instead of every row in the list.
const WebmailListItem = memo(function WebmailListItem({
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
	const dict = useOptionalDictionary();
	const router = useRouter();
	const [isDeleting, setIsDeleting] = useState(false);
	const [busy, setBusy] = useState(false);

	const threadUrl = `${threadBaseHref}${mailboxThreadItem.threadId}`;
	const allNames = getParticipantNames(mailboxThreadItem.participants);

	const unreadCount = Number(mailboxThreadItem.unreadCount ?? 0);
	const isUnread = unreadCount > 0;
	const isRead = !isUnread;
	const canMarkAsRead = isUnread;
	const canMarkAsUnread = mailboxThreadItem.messageCount > 0 && isRead;

	const runAction = async (action: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} catch (error) {
			toast.error(dict?.mailbox?.actionFailed ?? "Action failed", {
				description: error instanceof Error ? error.message : undefined,
				position: "bottom-left",
			});
		} finally {
			setBusy(false);
		}
	};

	// Hide the row right away and roll back if the server action fails.
	const deleteThread = async (e: React.MouseEvent) => {
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
			toast.success(dict?.mailbox?.movedToTrash ?? "Messages moved to Trash", {
				position: "bottom-left",
			});
			router.refresh();
		} catch (error) {
			setIsDeleting(false);
			toast.error(dict?.mailbox?.deleteFailed ?? "Delete failed", {
				description: error instanceof Error ? error.message : undefined,
				position: "bottom-left",
			});
		}
	};

	if (isDeleting) return null;

	return (
		<li
			className={[
				"group relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-3 py-3 transition-colors hover:bg-muted/50 has-[:focus-visible]:bg-muted/50 xl:grid-cols-[auto_minmax(10rem,20rem)_minmax(10rem,1fr)_auto] xl:items-center xl:gap-3 xl:py-2 xl:pr-28",
				isRead
					? "bg-muted/50 text-muted-foreground"
					: "bg-background font-semibold text-foreground",
			].join(" ")}
		>
			{/* Keep the existing full reload for Snoozed until its parallel route is hoisted. */}
			{isOnSnoozedPage ? (
				<a href={threadUrl} className="absolute inset-0">
					<span className="sr-only">{mailboxThreadItem.subject}</span>
				</a>
			) : (
				<Link href={threadUrl} className="absolute inset-0">
					<span className="sr-only">{mailboxThreadItem.subject}</span>
				</Link>
			)}

			<div className="relative z-10 row-span-2 flex items-start gap-2 pt-1 xl:row-span-1 xl:items-center xl:pt-0">
				{!isOnSnoozedPage && (
					<input
						type="checkbox"
						onChange={(e) =>
							onToggleSelect(mailboxThreadItem.threadId, e.target.checked)
						}
						checked={selected}
						aria-label={`${dict?.mailbox?.selectThreadPrefix ?? "Select thread "}${mailboxThreadItem.subject}`}
						className="size-4 rounded border-muted-foreground/40"
					/>
				)}

				<button
					type="button"
					aria-label={
						mailboxThreadItem.starred
							? (dict?.mailbox?.unstar ?? "Unstar")
							: (dict?.mailbox?.star ?? "Star")
					}
					aria-pressed={mailboxThreadItem.starred}
					disabled={busy}
					className="text-muted-foreground hover:text-foreground"
					onClick={() =>
						runAction(() =>
							toggleStar(
								mailboxThreadItem.threadId,
								activeMailbox.id,
								mailboxThreadItem.starred,
								!!mailboxSync,
							),
						)
					}
				>
					{mailboxThreadItem.starred ? (
						<IconStarFilled className={"text-yellow-400"} size={12} />
					) : (
						<IconStar className="size-3" />
					)}
				</button>
			</div>

			<div className="pointer-events-none flex min-w-0 items-center gap-2 pr-2">
				<span
					className={[
						"size-2 shrink-0 rounded-full",
						isUnread ? "bg-primary" : "bg-transparent",
					].join(" ")}
					aria-hidden="true"
				/>
				{isUnread && (
					<span className="sr-only">{dict?.mailbox?.unread ?? "Unread"}</span>
				)}
				<span className="truncate">{allNames}</span>
				{mailboxThreadItem.messageCount > 1 && (
					<span className="shrink-0 text-xs text-muted-foreground font-normal">
						{mailboxThreadItem.messageCount}
					</span>
				)}
			</div>

			<div className="pointer-events-none col-start-2 flex min-w-0 items-center gap-1 pr-2 text-sm font-normal text-muted-foreground xl:col-start-auto">
				<LabelRowTag
					threadId={mailboxThreadItem.threadId}
					labelsByThreadId={labelsByThreadId}
					isRead={isRead}
				/>
				<span
					className={[
						"truncate text-foreground",
						isUnread ? "font-semibold" : "",
					].join(" ")}
				>
					{mailboxThreadItem.subject}
				</span>
				<span className="mx-1 hidden text-muted-foreground sm:inline">–</span>
				<span className="hidden truncate text-muted-foreground sm:inline">
					{mailboxThreadItem.previewText}
				</span>
				{mailboxThreadItem.hasAttachments && (
					<Paperclip className="ml-1 hidden size-4 shrink-0 text-muted-foreground sm:inline" />
				)}
			</div>

			<div className="pointer-events-none col-start-3 row-span-2 row-start-1 ml-auto flex flex-col items-end gap-1 pl-2 xl:col-start-auto xl:row-span-1 xl:flex-row xl:items-center xl:gap-2">
				<div className="flex items-center gap-2">
					{isUnread ? (
						<Mail className="size-4 text-primary xl:hidden" />
					) : (
						<MailOpen className="size-4 text-muted-foreground xl:hidden" />
					)}
					<ThreadTime item={mailboxThreadItem} />
				</div>
				<div className="pointer-events-auto relative z-10 xl:hidden">
					<ThreadLabelHoverButtons
						mailboxThreadItem={mailboxThreadItem}
						labelsByThreadId={labelsByThreadId}
						allLabels={globalLabels}
					/>
				</div>
			</div>

			<div className="pointer-events-none absolute inset-y-0 right-3 z-20 hidden w-28 items-center justify-end gap-1 rounded-l-4xl bg-muted px-3 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 xl:flex">
				<ThreadLabelHoverButtons
					mailboxThreadItem={mailboxThreadItem}
					labelsByThreadId={labelsByThreadId}
					allLabels={globalLabels}
				/>

				{canMarkAsUnread && (
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							runAction(() =>
								markAsUnread(
									mailboxThreadItem.threadId,
									activeMailbox.id,
									!!mailboxSync,
									true,
								),
							)
						}
						className="rounded p-1 hover:bg-muted"
						title={dict?.mailbox?.markAsUnread ?? "Mark as unread"}
						aria-label={dict?.mailbox?.markAsUnread ?? "Mark as unread"}
					>
						<Mail className="size-4" />
					</button>
				)}
				{canMarkAsRead && (
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							runAction(() =>
								markAsRead(
									mailboxThreadItem.threadId,
									activeMailbox.id,
									!!mailboxSync,
								),
							)
						}
						className="rounded p-1 hover:bg-muted"
						title={dict?.mailbox?.markAsRead ?? "Mark as read"}
						aria-label={dict?.mailbox?.markAsRead ?? "Mark as read"}
					>
						<MailOpen className="size-4" />
					</button>
				)}

				<SnoozeMail
					mailboxThreadId={mailboxThreadItem.threadId}
					activeMailboxId={activeMailbox.id}
				/>

				<button
					type="button"
					onClick={deleteThread}
					className="rounded p-1 hover:bg-muted"
					title={dict?.mailbox?.delete ?? "Delete"}
					aria-label={dict?.mailbox?.delete ?? "Delete"}
				>
					<Trash2 className="size-4" />
				</button>
			</div>
		</li>
	);
});

export default WebmailListItem;
