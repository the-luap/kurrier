import MailboxOverview from "@/components/mailbox/mailbox-overview";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import { fetchMailboxOverview } from "@/lib/actions/mailbox";

export default async function Page() {
	const overview = await fetchMailboxOverview();
	const workspacePublicId = await getWorkspacePublicId();

	return <MailboxOverview overview={overview} workspacePublicId={workspacePublicId} />;
}
