import ScheduledList from "@/components/mailbox/default/scheduled-list";
import { fetchScheduledDrafts } from "@/lib/actions/mailbox";

async function Page(props: {
	params: Promise<{ identityPublicId: string; mailboxSlug: string }>;
}) {
	const { identityPublicId } = await props.params;
	const scheduledDrafts = await fetchScheduledDrafts(identityPublicId);
	// ScheduledList renders its own card + <ul>; wrapping it in another <ul>
	// produced invalid markup (<div> inside <ul>) and a hydration warning.
	return (
		<div className="p-4">
			<ScheduledList drafts={scheduledDrafts} />
		</div>
	);
}

export default Page;
