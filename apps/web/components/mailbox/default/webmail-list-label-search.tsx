"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import type { PublicConfig } from "@schema";
import { MailThreadListView } from "@/components/mailbox/default/webmail-list";
import type {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import type {
	FetchIdentityMailboxListResult,
	FetchMailboxThreadsResult,
} from "@/lib/actions/mailbox";

type WebListProps = {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	activeMailbox: MailboxEntity;
	identityPublicId: string;
	identityMailboxes: FetchIdentityMailboxListResult;
	globalLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	workspacePublicId: string;
	mailboxSync?: MailboxSyncEntity;
};

export default function WebmailListLabelSearch({
	mailboxThreads,
	identityPublicId,
	mailboxSync,
	activeMailbox,
	publicConfig,
	identityMailboxes,
	globalLabels,
	workspacePublicId,
	labelsByThreadId,
}: WebListProps) {
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
