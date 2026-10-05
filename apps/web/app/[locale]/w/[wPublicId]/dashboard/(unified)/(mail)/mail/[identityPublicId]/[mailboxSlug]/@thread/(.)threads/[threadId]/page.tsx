import { connection } from "next/server";
import { Suspense } from "react";
import Loading from "@/app/loading";
import ThreadDetail from "@/components/mailbox/default/thread-detail";

async function ThreadContent({
	params,
}: {
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
		threadId: string;
	}>;
}) {
	await connection();

	const { threadId, identityPublicId, mailboxSlug } = await params;

	return (
		<ThreadDetail
			identityPublicId={identityPublicId}
			mailboxSlug={mailboxSlug}
			threadId={threadId}
		/>
	);
}

function Page({
	params,
}: {
	params: Promise<{
		identityPublicId: string;
		mailboxSlug: string;
		threadId: string;
	}>;
}) {
	return (
		<Suspense fallback={<Loading />}>
			<ThreadContent params={params} />
		</Suspense>
	);
}

export default Page;
