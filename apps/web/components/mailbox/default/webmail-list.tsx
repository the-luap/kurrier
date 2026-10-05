"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import type { PublicConfig } from "@schema";
import { useParams, usePathname } from "next/navigation";
import {
	use,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import MailListHeader from "@/components/mailbox/default/mail-list-header";
import {
	CLOSE_THREAD_EVENT,
	clearThreadOrder,
	publishThreadOrder,
} from "@/components/mailbox/default/thread-navigation-store";
import WebmailListItem from "@/components/mailbox/default/webmail-list-item";
import { useOptionalDictionary } from "@/components/providers/dictionary-provider";
import {
	DynamicContextProvider,
	useDynamicContext,
} from "@/hooks/use-dynamic-context";
import type {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import type {
	FetchIdentityMailboxListResult,
	FetchMailboxResult,
	FetchMailboxThreadsResult,
} from "@/lib/actions/mailbox";

type WebListProps = {
	mailboxThreadPromise: Promise<{
		mailboxThreads: FetchMailboxThreadsResult;
		labelsByThreadId: FetchMailboxThreadLabelsResult;
	}>;
	publicConfig: PublicConfig;
	identityPublicId: string;
	identityMailboxesPromise: Promise<FetchIdentityMailboxListResult>;
	fetchMailboxPromise: Promise<FetchMailboxResult>;
	globalLabelsPromise: Promise<FetchLabelsResult>;
	workspacePublicId: string;
};

export type SelectionState = {
	selectedThreadIds: Set<string>;
	activeMailbox: MailboxEntity;
	identityPublicId: string;
};

export default function WebmailList({
	mailboxThreadPromise,
	identityPublicId,
	publicConfig,
	identityMailboxesPromise,
	globalLabelsPromise,
	workspacePublicId,
	fetchMailboxPromise,
}: WebListProps) {
	const { labelsByThreadId, mailboxThreads } = use(mailboxThreadPromise);
	const globalLabels = use(globalLabelsPromise);
	const { mailboxSync, activeMailbox } = use(fetchMailboxPromise);
	const identityMailboxes = use(identityMailboxesPromise);

	return (
		<MailThreadListView
			mailboxThreads={mailboxThreads}
			labelsByThreadId={labelsByThreadId}
			globalLabels={globalLabels}
			mailboxSync={mailboxSync ?? undefined}
			activeMailbox={activeMailbox}
			identityMailboxes={identityMailboxes}
			identityPublicId={identityPublicId}
			publicConfig={publicConfig}
			workspacePublicId={workspacePublicId}
		/>
	);
}

type ListViewProps = {
	mailboxThreads: FetchMailboxThreadsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	globalLabels: FetchLabelsResult;
	mailboxSync: MailboxSyncEntity | undefined;
	activeMailbox: MailboxEntity;
	identityMailboxes: FetchIdentityMailboxListResult;
	identityPublicId: string;
	publicConfig: PublicConfig;
	workspacePublicId: string;
};

/**
 * Shared by the mailbox list and the label/search/snoozed lists: hides the
 * list while a thread is open (and immediately when the thread is closed),
 * publishes the thread order for Previous/Next, and owns the selection.
 */
export function MailThreadListView({
	mailboxThreads,
	labelsByThreadId,
	globalLabels,
	mailboxSync,
	activeMailbox,
	identityMailboxes,
	identityPublicId,
	publicConfig,
	workspacePublicId,
}: ListViewProps) {
	const dict = useOptionalDictionary();
	const params = useParams();
	const threadId = params?.threadId ? String(params.threadId) : null;

	// The list is hidden while a thread is open. "Close" in the thread panel
	// shows the list immediately (before the route change lands), so remember
	// which thread was closed instead of mirroring the route param into state.
	const [closedThreadId, setClosedThreadId] = useState<string | null>(null);
	const threadOpen = Boolean(threadId) && closedThreadId !== threadId;
	const [prevThreadId, setPrevThreadId] = useState(threadId);
	if (prevThreadId !== threadId) {
		setPrevThreadId(threadId);
		setClosedThreadId(null);
	}

	useEffect(() => {
		if (!threadId) return;
		const closeThread = () => setClosedThreadId(threadId);
		window.addEventListener(CLOSE_THREAD_EVENT, closeThread);
		return () => window.removeEventListener(CLOSE_THREAD_EVENT, closeThread);
	}, [threadId]);

	const threadBaseHref = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${activeMailbox.slug}/threads/`;

	useEffect(() => {
		publishThreadOrder({
			baseHref: threadBaseHref,
			threadIds: mailboxThreads.map((t) => t.threadId),
		});
	}, [threadBaseHref, mailboxThreads]);

	useEffect(
		() => () => clearThreadOrder(threadBaseHref),
		[threadBaseHref],
	);

	const initialState = useMemo<SelectionState>(
		() => ({
			selectedThreadIds: new Set(),
			activeMailbox,
			identityPublicId,
		}),
		[activeMailbox, identityPublicId],
	);

	return (
		<div className={threadOpen ? "hidden" : "min-w-0"}>
			<DynamicContextProvider initialState={initialState}>
				{mailboxThreads.length === 0 ? (
					<div className="p-4 text-center text-base text-muted-foreground">
						{dict?.mailbox?.noMessagesInPrefix ?? "No messages in "}
						<span className={"lowercase"}>{activeMailbox.name}</span>
					</div>
				) : (
					<div className="min-w-0 overflow-hidden rounded-xl border bg-background/50">
						<MailListHeader
							mailboxThreads={mailboxThreads}
							mailboxSync={mailboxSync}
							publicConfig={publicConfig}
							identityMailboxes={identityMailboxes}
							activeMailbox={activeMailbox}
						/>

						<WebmailRows
							mailboxThreads={mailboxThreads}
							activeMailbox={activeMailbox}
							mailboxSync={mailboxSync}
							globalLabels={globalLabels}
							labelsByThreadId={labelsByThreadId}
							threadBaseHref={threadBaseHref}
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
	mailboxSync,
	globalLabels,
	labelsByThreadId,
	threadBaseHref,
}: {
	mailboxThreads: FetchMailboxThreadsResult;
	activeMailbox: MailboxEntity;
	mailboxSync: MailboxSyncEntity | undefined;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	threadBaseHref: string;
}) {
	const pathname = usePathname();
	const isOnSnoozedPage = pathname.split("/").includes("snoozed");

	const { state, setState } = useDynamicContext<SelectionState>();
	const selectedThreadIds = state.selectedThreadIds;

	// The list stays mounted across ?page= changes and refreshes after a
	// move/delete: drop selected threads that are no longer listed, so bulk
	// actions never act on rows the user cannot see.
	useEffect(() => {
		const visible = new Set(mailboxThreads.map((t) => t.threadId));
		setState((prev) => {
			let changed = false;
			const next = new Set<string>();
			for (const id of prev.selectedThreadIds) {
				if (visible.has(id)) next.add(id);
				else changed = true;
			}
			return changed ? { ...prev, selectedThreadIds: next } : prev;
		});
	}, [mailboxThreads, setState]);

	const onToggleSelect = useCallback(
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
		<ul className="divide-y rounded-4xl">
			{mailboxThreads.map((mailboxThreadItem) => (
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
			))}
		</ul>
	);
}
