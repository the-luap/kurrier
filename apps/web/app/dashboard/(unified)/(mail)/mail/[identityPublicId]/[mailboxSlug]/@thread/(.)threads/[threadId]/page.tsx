import {
	fetchAdjacentMailboxThreads,
	fetchMailbox,
	fetchThreadMailSubscriptions,
	fetchWebMailThreadDetail,
} from "@/lib/actions/mailbox";
import ThreadItem from "@/components/mailbox/default/thread-item";
import ThreadNavigationControls from "@/components/mailbox/default/thread-navigation-controls";
import { Divider } from "@mantine/core";
import type { MessageEntity } from "@db";

async function Page({
	params,
}: {
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
		threadId: string;
	}>;
}) {
	const { threadId, identityPublicId, mailboxSlug } = await params;
	const { activeMailbox, mailboxSync } = await fetchMailbox(
		identityPublicId,
		mailboxSlug,
	);
	const activeThread = await fetchWebMailThreadDetail(threadId);

	if (!activeMailbox) {
		return (
			<div className="p-4 text-sm text-muted-foreground">
				Mailbox is not available yet. Refresh this page in a moment.
			</div>
		);
	}

	const { previousThreadId, nextThreadId } = await fetchAdjacentMailboxThreads(
		identityPublicId,
		mailboxSlug,
		threadId,
	);
	const baseHref = `/dashboard/mail/${identityPublicId}/${mailboxSlug}`;

	const { byMessageId } = await fetchThreadMailSubscriptions({
		ownerId: activeMailbox.ownerId,
		messages:
			activeThread?.messages.map((m: MessageEntity) => ({
				id: m.id,
				headersJson: m.headersJson,
			})) ?? [],
	});

	return (
		<>
			<ThreadNavigationControls
				backHref={baseHref}
				previousHref={
					previousThreadId ? `${baseHref}/threads/${previousThreadId}` : null
				}
				nextHref={nextThreadId ? `${baseHref}/threads/${nextThreadId}` : null}
				messageCount={activeThread?.messages.length ?? 0}
			/>
			{activeThread?.messages.map((message, threadIndex) => {
				return (
					<div key={message.id}>
						<ThreadItem
							message={message}
							threadIndex={threadIndex}
							numberOfMessages={activeThread.messages.length}
							threadId={threadId}
							activeMailboxId={activeMailbox.id}
							markSmtp={!!mailboxSync}
							identityPublicId={identityPublicId}
							mailSubscription={byMessageId.get(message.id) ?? null}
						/>
						<Divider className={"opacity-50 mb-6"} ml={"xl"} mr={"xl"} />
					</div>
				);
			})}
		</>
	);
}

export default Page;
