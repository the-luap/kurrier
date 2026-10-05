import type { MessageEntity } from "@db";
import { Divider } from "@mantine/core";
import ThreadItem from "@/components/mailbox/default/thread-item";
import ThreadNavigationControls from "@/components/mailbox/default/thread-navigation-controls";
import {
	fetchAdjacentMailboxThreads,
	fetchMailbox,
	fetchThreadMailSubscriptions,
	fetchWebMailThreadDetail,
} from "@/lib/actions/mailbox";

// Shared by the full thread page and the intercepted (@thread) thread panel.
export default async function ThreadDetail({
	identityPublicId,
	mailboxSlug,
	threadId,
}: {
	identityPublicId: string;
	mailboxSlug: string;
	threadId: string;
}) {
	// None of these depend on each other: fetch them in one round trip
	// instead of waiting for the mailbox before loading the neighbours.
	const [mailboxResult, activeThread, adjacentThreads] = await Promise.all([
		fetchMailbox(identityPublicId, mailboxSlug),
		fetchWebMailThreadDetail(threadId),
		fetchAdjacentMailboxThreads(identityPublicId, mailboxSlug, threadId),
	]);
	const { activeMailbox, mailboxSync } = mailboxResult;

	if (!activeMailbox) {
		return (
			<div className="p-4 text-sm text-muted-foreground">
				Mailbox is not available yet. Refresh this page in a moment.
			</div>
		);
	}

	const { byMessageId } = await fetchThreadMailSubscriptions({
		ownerId: activeMailbox.ownerId,
		messages:
			activeThread?.messages.map((m: MessageEntity) => ({
				id: m.id,
				headersJson: m.headersJson,
			})) ?? [],
	});

	const baseHref = `/dashboard/mail/${identityPublicId}/${mailboxSlug}`;
	const { previousThreadId, nextThreadId } = adjacentThreads;
	const messages = activeThread?.messages ?? [];

	return (
		<div data-thread-panel>
			<ThreadNavigationControls
				backHref={baseHref}
				previousHref={
					previousThreadId ? `${baseHref}/threads/${previousThreadId}` : null
				}
				nextHref={nextThreadId ? `${baseHref}/threads/${nextThreadId}` : null}
				messageCount={messages.length}
			/>
			{messages.map((message, threadIndex) => (
				<div key={message.id}>
					<ThreadItem
						message={message}
						threadIndex={threadIndex}
						numberOfMessages={messages.length}
						threadId={threadId}
						activeMailboxId={activeMailbox.id}
						markSmtp={!!mailboxSync}
						identityPublicId={identityPublicId}
						mailSubscription={byMessageId.get(message.id) ?? null}
					/>
					<Divider className={"opacity-50 mb-6"} ml={"xl"} mr={"xl"} />
				</div>
			))}
		</div>
	);
}
