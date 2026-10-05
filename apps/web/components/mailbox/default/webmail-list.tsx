"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import { useMediaQuery } from "@mantine/hooks";
import type { PublicConfig } from "@schema";
import { useParams, usePathname } from "next/navigation";
import * as React from "react";
import MailListHeader from "@/components/mailbox/default/mail-list-header";
import { getThreadBaseHref } from "@/components/mailbox/default/thread-list-utils";
import WebmailListItem from "@/components/mailbox/default/webmail-list-item";
import WebmailListItemMobile from "@/components/mailbox/default/webmail-list-item-mobile";
import {
	DynamicContextProvider,
	useDynamicContext,
} from "@/hooks/use-dynamic-context";
import type {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import type { FetchMailboxThreadsResult } from "@/lib/actions/mailbox";

type WebListProps = {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	activeMailbox: MailboxEntity;
	identityPublicId: string;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	mailboxSync?: MailboxSyncEntity;
};

type SelectionState = {
	selectedThreadIds: Set<string>;
	activeMailbox: MailboxEntity;
	identityPublicId: string;
};

export default function WebmailList({
	mailboxThreads,
	activeMailbox,
	identityPublicId,
	mailboxSync,
	publicConfig,
	globalLabels,
	labelsByThreadId,
}: WebListProps) {
	const params = useParams();
	const threadId = params?.threadId ? String(params.threadId) : null;

	// The list is hidden while a thread is open. "Close" in the thread panel
	// hides the list's thread immediately (before the route change lands), so
	// remember which thread was closed instead of mirroring the route param
	// into state with an effect (which cost an extra render of the list).
	const [closedThreadId, setClosedThreadId] = React.useState<string | null>(
		null,
	);
	const threadOpen = Boolean(threadId) && closedThreadId !== threadId;
	const [prevThreadId, setPrevThreadId] = React.useState(threadId);
	if (prevThreadId !== threadId) {
		setPrevThreadId(threadId);
		setClosedThreadId(null);
	}

	React.useEffect(() => {
		if (!threadId) return;
		const closeThread = () => setClosedThreadId(threadId);
		window.addEventListener("kurrier:close-thread", closeThread);
		return () =>
			window.removeEventListener("kurrier:close-thread", closeThread);
	}, [threadId]);

	const initialState = React.useMemo<SelectionState>(
		() => ({
			selectedThreadIds: new Set(),
			activeMailbox,
			identityPublicId,
		}),
		[activeMailbox, identityPublicId],
	);

	return (
		<div className={threadOpen ? "hidden" : ""}>
			<DynamicContextProvider initialState={initialState}>
				{mailboxThreads.length === 0 ? (
					<div className="p-4 text-center text-base text-muted-foreground">
						No messages in{" "}
						<span className={"lowercase"}>{activeMailbox.name}</span>
					</div>
				) : (
					<div className="rounded-xl border bg-background/50 z-[50]">
						<MailListHeader
							mailboxThreads={mailboxThreads}
							mailboxSync={mailboxSync}
							publicConfig={publicConfig}
							activeMailbox={activeMailbox}
						/>

						<WebmailRows
							mailboxThreads={mailboxThreads}
							activeMailbox={activeMailbox}
							identityPublicId={identityPublicId}
							mailboxSync={mailboxSync}
							globalLabels={globalLabels}
							labelsByThreadId={labelsByThreadId}
						/>
					</div>
				)}
			</DynamicContextProvider>
		</div>
	);
}

// Reads the selection from context once and hands each (memoized) row a
// boolean + a stable callback, so toggling one checkbox re-renders one row
// instead of every row subscribing to the whole selection set.
function WebmailRows({
	mailboxThreads,
	activeMailbox,
	identityPublicId,
	mailboxSync,
	globalLabels,
	labelsByThreadId,
}: Omit<WebListProps, "publicConfig">) {
	const isMobile = useMediaQuery("(max-width: 768px)");
	const pathname = usePathname();
	const isOnSnoozedPage = pathname.split("/").includes("snoozed");
	const threadBaseHref = getThreadBaseHref(
		pathname,
		identityPublicId,
		activeMailbox.slug,
	);

	const { state, setState } = useDynamicContext<SelectionState>();
	const selectedThreadIds = state.selectedThreadIds;

	const onToggleSelect = React.useCallback(
		(threadId: string, checked: boolean) => {
			setState((prev) => {
				const next = new Set(prev.selectedThreadIds);
				if (checked) next.add(threadId);
				else next.delete(threadId);
				return { ...prev, selectedThreadIds: next };
			});
		},
		[setState],
	);

	return (
		<ul role="list" className={`divide-y rounded-4xl`}>
			{mailboxThreads.map((mailboxThreadItem) =>
				isMobile ? (
					<WebmailListItemMobile
						key={mailboxThreadItem.threadId + mailboxThreadItem.mailboxId}
						mailboxThreadItem={mailboxThreadItem}
						activeMailbox={activeMailbox}
						mailboxSync={mailboxSync}
						labelsByThreadId={labelsByThreadId}
						threadBaseHref={threadBaseHref}
						selected={selectedThreadIds.has(mailboxThreadItem.threadId)}
						onToggleSelect={onToggleSelect}
					/>
				) : (
					<WebmailListItem
						key={mailboxThreadItem.threadId + mailboxThreadItem.mailboxId}
						mailboxThreadItem={mailboxThreadItem}
						activeMailbox={activeMailbox}
						mailboxSync={mailboxSync}
						globalLabels={globalLabels}
						labelsByThreadId={labelsByThreadId}
						threadBaseHref={threadBaseHref}
						isOnSnoozedPage={isOnSnoozedPage}
						selected={selectedThreadIds.has(mailboxThreadItem.threadId)}
						onToggleSelect={onToggleSelect}
					/>
				),
			)}
		</ul>
	);
}
