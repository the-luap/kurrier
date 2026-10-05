import type { MailSubscriptionEntity, MessageEntity } from "@db";
import type { PublicConfig } from "@schema";
import { Container } from "@/components/common/containers";
import EmailRenderer, {
	type MessageAttachmentWithUrl,
} from "@/components/mailbox/default/email-renderer";
import RenderInvite from "@/components/mailbox/default/render-invite";
import type { FetchEventPreviewItemsResult } from "@/lib/actions/calendar";
import type {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import type { FetchIdentityMailboxListResult } from "@/lib/actions/mailbox";

type Preview =
	| FetchEventPreviewItemsResult
	| { calendarEvent: null; attendees: null; identity: null };

export default function ThreadItem({
	message,
	threadIndex,
	numberOfMessages,
	threadId,
	activeMailboxId,
	activeMailboxKind,
	markSmtp,
	mailSubscription,
	allLabels,
	labelsByThreadId,
	identityMailboxes,
	attachments,
	preview,
	cidUrls,
	publicConfig,
	backHref,
}: {
	message: MessageEntity;
	threadIndex: number;
	numberOfMessages: number;
	threadId: string;
	activeMailboxId: string;
	activeMailboxKind: string;
	markSmtp: boolean;
	mailSubscription: MailSubscriptionEntity | null;
	allLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	identityMailboxes: FetchIdentityMailboxListResult;
	attachments: MessageAttachmentWithUrl[];
	preview: Preview;
	/** Lower-cased content id -> signed URL of the inline image. */
	cidUrls: Record<string, string>;
	publicConfig: PublicConfig;
	backHref: string;
}) {
	// The message goes to the client once (the renderer hands it to the body
	// viewer and the inspector). textAsHtml is a second HTML copy of the text
	// part that no client component reads.
	const clientMessage: MessageEntity = { ...message, textAsHtml: null };

	return (
		<Container variant="wide">
			<div className={"grid grid-cols-12 p-3"}>
				<div className={"col-span-12 md:col-span-11"}>
					{preview?.calendarEvent &&
						preview?.attendees &&
						preview?.identity && (
							<RenderInvite
								calendarEvent={preview.calendarEvent}
								attendees={preview.attendees ?? []}
								identity={preview.identity}
							/>
						)}

					<EmailRenderer
						threadIndex={threadIndex}
						numberOfMessages={numberOfMessages}
						message={clientMessage}
						attachments={attachments}
						publicConfig={publicConfig}
						threadId={threadId}
						markSmtp={markSmtp}
						activeMailboxId={activeMailboxId}
						activeMailboxKind={activeMailboxKind}
						mailSubscription={mailSubscription}
						identityMailboxes={identityMailboxes}
						allLabels={allLabels}
						labelsByThreadId={labelsByThreadId}
						backHref={backHref}
						cidUrls={cidUrls}
					/>
				</div>
			</div>
		</Container>
	);
}
