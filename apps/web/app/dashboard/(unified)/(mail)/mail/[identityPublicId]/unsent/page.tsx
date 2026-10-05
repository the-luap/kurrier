import DraftList from "@/components/mailbox/default/draft-list";
import { fetchDrafts } from "@/lib/actions/mailbox";

async function Page(props: { params: Promise<{ identityPublicId: string }> }) {
	const { identityPublicId } = await props.params;
	const drafts = await fetchDrafts(identityPublicId);
	return (
		<div className="p-4">
			<DraftList drafts={drafts} />
		</div>
	);
}

export default Page;
