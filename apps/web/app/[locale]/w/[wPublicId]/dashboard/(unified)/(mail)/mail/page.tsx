import MailboxOverview from "@/components/mailbox/mailbox-overview";
import { fetchMailboxOverview } from "@/lib/actions/mailbox";

export default async function Page() {
	const overview = await fetchMailboxOverview();

	return <MailboxOverview overview={overview} />;
}
