import type { MailSubscriptionEntity, MessageEntity } from "@db";
import { getPublicEnv } from "@schema";
import { Container } from "@/components/common/containers";
import {
	getAuthStatus,
	hasKnownAuthStatus,
} from "@/components/mailbox/default/auth-status";
import EmailRenderer from "@/components/mailbox/default/email-renderer";
import EmailViewer from "@/components/mailbox/default/email-viewer";
import RenderInvite from "@/components/mailbox/default/render-invite";
import { fetchEventPreviewItems } from "@/lib/actions/calendar";
import { fetchMessageAttachments } from "@/lib/actions/mailbox";
import { createClient } from "@/lib/supabase/server";

export default async function ThreadItem({
	message,
	threadIndex,
	numberOfMessages,
	threadId,
	activeMailboxId,
	markSmtp,
	identityPublicId,
	mailSubscription,
}: {
	message: MessageEntity;
	threadIndex: number;
	numberOfMessages: number;
	threadId: string;
	activeMailboxId: string;
	markSmtp: boolean;
	identityPublicId: string;
	mailSubscription: MailSubscriptionEntity | null;
}) {
	const { attachments } = await fetchMessageAttachments(message.id);
	const publicConfig = getPublicEnv();

	// Only serialize what the client components need: the body goes to the
	// viewer once, and the (often huge) raw headers / textAsHtml copies stay
	// on the server. This keeps the RSC payload of long threads small.
	const { html, text, textAsHtml: _textAsHtml, headersJson, ...meta } = message;
	const headers = (headersJson ?? {}) as Record<string, any>;
	// SPF/DKIM/DMARC need the full (server-only) headers: compute them here and
	// pass just the result. Drafts / own sent copies carry no meaningful result.
	const fullAuthStatus = message.draft ? null : getAuthStatus(headers);
	const authStatus = hasKnownAuthStatus(fullAuthStatus) ? fullAuthStatus : null;
	const headerMessage = {
		...meta,
		html: null,
		text: null,
		textAsHtml: null,
		headersJson: {
			from: headers.from?.text ? { text: headers.from.text } : undefined,
			to: headers.to?.text ? { text: headers.to.text } : undefined,
			subject: headers.subject,
		},
	} as unknown as MessageEntity;
	const bodyMessage = {
		id: message.id,
		html,
		text,
		from: message.from,
	} as MessageEntity;

	// Inline images ("cid:" references) are stored as attachments: resolve
	// them to signed URLs and don't list them a second time as attachments.
	const lowerHtml = (html ?? "").toLowerCase();
	const cleanCid = (cid: string) => cid.replace(/^<|>$/g, "").toLowerCase();
	const inlineAttachments = attachments.filter(
		(a) => a.cid && lowerHtml.includes(`cid:${cleanCid(a.cid)}`),
	);
	const visibleAttachments = attachments.filter(
		(a) => !inlineAttachments.includes(a),
	);

	// Sign inline images and attachment previews in one storage call instead
	// of one client-side request per attachment card, in parallel with the
	// calendar-invite lookup.
	const toSign = attachments.filter((a) => a.path);
	const signAttachments = async () => {
		const cidUrls: Record<string, string> = {};
		const attachmentUrls: Record<string, string> = {};
		if (toSign.length === 0) return { cidUrls, attachmentUrls };
		const supabase = await createClient();
		const { data } = await supabase.storage
			.from("attachments")
			.createSignedUrls(
				toSign.map((a) => String(a.path)),
				60 * 60,
			);
		toSign.forEach((a, i) => {
			const url = data?.[i]?.signedUrl;
			if (!url) return;
			if (a.cid && inlineAttachments.includes(a)) {
				cidUrls[cleanCid(a.cid)] = url;
			} else {
				attachmentUrls[String(a.id)] = url;
			}
		});
		return { cidUrls, attachmentUrls };
	};
	const [preview, { cidUrls, attachmentUrls }] = await Promise.all([
		fetchEventPreviewItems(attachments, identityPublicId),
		signAttachments(),
	]);

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
						message={headerMessage}
						attachments={visibleAttachments}
						publicConfig={publicConfig}
						threadId={threadId}
						markSmtp={markSmtp}
						activeMailboxId={activeMailboxId}
						mailSubscription={mailSubscription}
						authStatus={authStatus}
						attachmentUrls={attachmentUrls}
					>
						<EmailViewer message={bodyMessage} cidUrls={cidUrls} />
					</EmailRenderer>
				</div>
			</div>
		</Container>
	);
}
