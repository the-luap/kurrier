import {
	fetchMailbox,
	fetchIdentitySnoozedThreads,
} from "@/lib/actions/mailbox";
import { fetchLabels, fetchMailboxThreadLabels } from "@/lib/actions/labels";
import { getPublicEnv } from "@schema";
import WebmailList from "@/components/mailbox/default/webmail-list";

export default async function SnoozedPage({
	params,
}: {
	params: { identityPublicId: string };
}) {
	const { identityPublicId } = await params;

	const publicConfig = getPublicEnv();
	const [globalLabels, { threads }] = await Promise.all([
		fetchLabels(),
		fetchIdentitySnoozedThreads(identityPublicId),
	]);

	const filteredThreads = threads.filter(
		(thread) => thread.identityPublicId === identityPublicId,
	);
	const firstMailboxSlug = threads[0]?.mailboxSlug || "inbox";
	const [labelsByThreadId, { activeMailbox }] = await Promise.all([
		threads.length > 0 ? fetchMailboxThreadLabels(threads) : {},
		fetchMailbox(identityPublicId, firstMailboxSlug),
	]);

	return (
		<div className="p-4 space-y-4">
			<header className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Snoozed</h1>
				<div className="text-sm text-muted-foreground">
					Threads: {filteredThreads.length}
				</div>
			</header>

			{filteredThreads.length === 0 ? (
				<div className="text-sm text-muted-foreground">No snoozed threads.</div>
			) : (
				<WebmailList
					mailboxThreads={filteredThreads}
					publicConfig={publicConfig}
					activeMailbox={activeMailbox}
					identityPublicId={identityPublicId}
					globalLabels={globalLabels}
					labelsByThreadId={labelsByThreadId}
				/>
			)}
		</div>
	);
}
