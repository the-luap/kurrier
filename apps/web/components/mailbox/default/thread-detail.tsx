import type { MessageEntity } from "@db";
import { Divider } from "@mantine/core";
import { getPublicEnv } from "@schema";
import MailboxPreparingNotice from "@/components/mailbox/default/mailbox-preparing-notice";
import MarkThreadRead from "@/components/mailbox/default/mark-thread-read";
import ThreadItem from "@/components/mailbox/default/thread-item";
import ThreadNavigationControls from "@/components/mailbox/default/thread-navigation-controls";
import { fetchEventPreviewItems } from "@/lib/actions/calendar";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import {
	fetchLabelsByIdentityPublicId,
	fetchMailboxThreadLabels,
} from "@/lib/actions/labels";
import {
	fetchIdentityMailboxList,
	fetchMailbox,
	fetchThreadMailSubscriptions,
	fetchWebMailThreadDetail,
	getSignedUrlsForMessage,
} from "@/lib/actions/mailbox";

const cleanCid = (cid: string) => cid.trim().replace(/^<|>$/g, "").toLowerCase();

const EMPTY_PREVIEW = {
	calendarEvent: null,
	attendees: null,
	identity: null,
} as const;

/**
 * Shared by the full thread page and the intercepted (@thread) thread panel.
 * Loads everything the thread needs in two parallel rounds instead of a
 * waterfall per message.
 */
export default async function ThreadDetail({
	identityPublicId,
	mailboxSlug,
	threadId,
}: {
	identityPublicId: string;
	mailboxSlug: string;
	threadId: string;
}) {
	const [
		mailboxResult,
		activeThread,
		workspacePublicId,
		allLabels,
		labelsByThreadId,
		identityMailboxes,
	] = await Promise.all([
		fetchMailbox(identityPublicId, mailboxSlug).catch(() => null),
		fetchWebMailThreadDetail(threadId),
		getWorkspacePublicId(),
		fetchLabelsByIdentityPublicId({
			identityPublicId,
			scope: "thread",
		}),
		fetchMailboxThreadLabels([{ threadId }]),
		fetchIdentityMailboxList(),
	]);

	if (!mailboxResult) {
		return <MailboxPreparingNotice />;
	}

	const { activeMailbox, mailboxSync } = mailboxResult;
	const messages: MessageEntity[] = activeThread?.messages ?? [];
	const publicConfig = getPublicEnv();

	const [{ byMessageId }, perMessage] = await Promise.all([
		fetchThreadMailSubscriptions({
			ownerId: activeMailbox.ownerId,
			messages: messages.map((m) => ({
				id: m.id,
				headersJson: m.headersJson,
			})),
		}),
		Promise.all(
			messages.map(async (message) => {
				// Most messages have no attachments: skip the lookup (and the
				// calendar-invite check, which needs an attachment) for them.
				if (!message.hasAttachments) {
					return {
						attachments: [],
						preview: EMPTY_PREVIEW,
						cidUrls: {} as Record<string, string>,
					};
				}
				const attachments = await getSignedUrlsForMessage(message.id);
				const preview = await fetchEventPreviewItems(
					attachments,
					identityPublicId,
				);
				// Inline images ("cid:" references in the HTML) are stored as
				// attachments: resolve them to their signed URLs and don't list
				// them a second time below the message.
				const lowerHtml = (message.html ?? "").toLowerCase();
				const cidUrls: Record<string, string> = {};
				const visible: typeof attachments = [];
				for (const attachment of attachments) {
					const cid = attachment.cid ? cleanCid(attachment.cid) : "";
					if (cid && lowerHtml.includes(`cid:${cid}`)) {
						cidUrls[cid] = attachment.signedUrl;
					} else {
						visible.push(attachment);
					}
				}
				return { attachments: visible, preview, cidUrls };
			}),
		),
	]);

	const backHref = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${mailboxSlug}`;
	const hasUnread = messages.some((message) => !message.seen);

	return (
		<div data-thread-panel>
			<ThreadNavigationControls
				backHref={backHref}
				threadId={threadId}
				messageCount={messages.length}
			/>

			{hasUnread && (
				<MarkThreadRead
					threadId={threadId}
					mailboxId={activeMailbox.id}
					markSmtp={!!mailboxSync}
				/>
			)}

			{messages.map((message, threadIndex) => (
				<div key={message.id}>
					<ThreadItem
						message={message}
						threadIndex={threadIndex}
						numberOfMessages={messages.length}
						threadId={threadId}
						activeMailboxId={activeMailbox.id}
						activeMailboxKind={activeMailbox.kind}
						markSmtp={!!mailboxSync}
						mailSubscription={byMessageId.get(message.id) ?? null}
						allLabels={allLabels}
						labelsByThreadId={labelsByThreadId}
						identityMailboxes={identityMailboxes}
						attachments={perMessage[threadIndex]?.attachments ?? []}
						preview={perMessage[threadIndex]?.preview ?? EMPTY_PREVIEW}
						cidUrls={perMessage[threadIndex]?.cidUrls ?? {}}
						publicConfig={publicConfig}
						backHref={backHref}
					/>
					<Divider className="opacity-50 mb-6" ml="xl" mr="xl" />
				</div>
			))}
		</div>
	);
}
