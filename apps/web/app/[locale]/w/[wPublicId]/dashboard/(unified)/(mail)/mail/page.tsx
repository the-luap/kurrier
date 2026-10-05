import { Suspense } from "react";
import Loading from "@/app/loading";
import DashboardPageHeader from "@/components/dashboard/dashboard-page-header";
import MailboxOverview from "@/components/mailbox/mailbox-overview";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import { fetchMailboxOverview } from "@/lib/actions/mailbox";
import { getI18n, type Locale } from "@/lib/dictionaries";

async function MailOverviewContent({
	params,
}: {
	params: Promise<{ locale: Locale }>;
}) {
	const { locale } = await params;
	const [{ dict, format }, overview, workspacePublicId] = await Promise.all([
		getI18n(locale),
		fetchMailboxOverview(),
		getWorkspacePublicId(),
	]);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<DashboardPageHeader title={dict.mailbox.mailTitle} />
			<MailboxOverview
				overview={overview}
				workspacePublicId={workspacePublicId}
				dict={dict.mailbox}
				format={format}
			/>
		</div>
	);
}

export default function Page({
	params,
}: {
	params: Promise<{ locale: Locale }>;
}) {
	return (
		<Suspense fallback={<Loading />}>
			<MailOverviewContent params={params} />
		</Suspense>
	);
}
