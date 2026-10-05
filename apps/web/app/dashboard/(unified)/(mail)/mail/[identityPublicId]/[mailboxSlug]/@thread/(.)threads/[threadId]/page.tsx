import ThreadDetail from "@/components/mailbox/default/thread-detail";

export default async function Page({
	params,
}: {
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
		threadId: string;
	}>;
}) {
	const { threadId, identityPublicId, mailboxSlug } = await params;
	return (
		<ThreadDetail
			identityPublicId={identityPublicId}
			mailboxSlug={mailboxSlug}
			threadId={threadId}
		/>
	);
}
