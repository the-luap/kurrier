import React from "react";
import { MessageEntity } from "@db";
import EmailViewer from "@/components/mailbox/default/email-viewer";
import EmailRenderer from "@/components/mailbox/default/email-renderer";
import { Avatar } from "@mantine/core";
import {fetchMessageAttachments, FetchThreadMailSubsResult} from "@/lib/actions/mailbox";
import { getPublicEnv } from "@schema";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import { Container } from "@/components/common/containers";
import RenderInvite from "@/components/mailbox/default/render-invite";
import {fetchEventPreviewItems} from "@/lib/actions/calendar";

export default async function ThreadItem({
	message,
	threadIndex,
	numberOfMessages,
	threadId,
	activeMailboxId,
	markSmtp,
    identityPublicId,
    mailSubscription
}: {
	message: MessageEntity;
	threadIndex: number;
	numberOfMessages: number;
	threadId: string;
	activeMailboxId: string;
	markSmtp: boolean;
    identityPublicId: string;
    mailSubscription: FetchThreadMailSubsResult["byMessageId"] | null;
}) {
	const { attachments } = await fetchMessageAttachments(message.id);
	const publicConfig = getPublicEnv();
    const preview = await fetchEventPreviewItems(attachments, identityPublicId)

	// Only serialize what the client components need: the body goes to the
	// viewer once, and the (often huge) raw headers / textAsHtml copies stay
	// on the server. This keeps the RSC payload of long threads small.
	const { html, text, textAsHtml: _textAsHtml, headersJson, ...meta } = message;
	const headers = (headersJson ?? {}) as Record<string, any>;
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
	const bodyMessage = { id: message.id, html, text } as MessageEntity;

	return (
		<>
			<Container variant="wide">
				<div className={"grid grid-cols-12 p-3"}>
					<div className={"md:col-span-1 hidden"}>
						<Avatar
							name={
								getMessageName(message, "from") ||
								getMessageAddress(message, "from") ||
								""
							}
							color="initials"
						/>
					</div>
					<div className={"col-span-12 md:col-span-11"}>
                        {preview?.calendarEvent && preview?.attendees && preview?.identity && (
                            <RenderInvite calendarEvent={preview.calendarEvent} attendees={preview.attendees ?? []} identity={preview.identity}/>
                        )}

						<EmailRenderer
							threadIndex={threadIndex}
							numberOfMessages={numberOfMessages}
							message={headerMessage}
							attachments={attachments}
							publicConfig={publicConfig}
							threadId={threadId}
							markSmtp={markSmtp}
							activeMailboxId={activeMailboxId}
                            mailSubscription={mailSubscription}
						>
							<EmailViewer message={bodyMessage} />
						</EmailRenderer>
					</div>
				</div>
			</Container>
		</>
	);
}
