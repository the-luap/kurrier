import { type ReactNode, Suspense } from "react";
import MailboxSearch from "@/components/mailbox/default/mailbox-search";
import { getIdentityByPublicId } from "@/components/mailbox/identity-by-public-id";
import IdentitySettingsLink from "@/components/mailbox/settings/identity-settings";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { isSignedIn } from "@/lib/actions/auth";

type Params = Promise<Record<string, string>>;

const HEADER_CLASS =
	"bg-background sticky top-0 flex shrink-0 items-center gap-2 border-b p-4 z-50";

function HeaderShell({ children }: { children?: ReactNode }) {
	return (
		<header className={HEADER_CLASS}>
			<SidebarTrigger className="-ml-1" />
			<Separator
				orientation="vertical"
				className="mr-2 data-[orientation=vertical]:h-4"
			/>
			{children}
		</header>
	);
}

async function MailboxSearchHeaderContent({ params }: { params: Params }) {
	const { identityPublicId, mailboxSlug } = await params;
	const [user, identity] = await Promise.all([
		isSignedIn(),
		getIdentityByPublicId(identityPublicId),
	]);

	return (
		<HeaderShell>
			<MailboxSearch
				user={user}
				publicId={identityPublicId}
				mailboxSlug={mailboxSlug}
			/>
			<IdentitySettingsLink identityLabel={identity?.value ?? ""} />
		</HeaderShell>
	);
}

// The header has its own Suspense boundary so the layout (and the page's
// loading.tsx below it) can render immediately instead of waiting for the
// auth + identity lookups.
function MailboxSearchHeader({ params }: { params: Params }) {
	return (
		<Suspense
			fallback={
				<HeaderShell>
					<div
						aria-hidden
						className="h-[42px] w-full animate-pulse rounded-lg border bg-muted/30"
					/>
				</HeaderShell>
			}
		>
			<MailboxSearchHeaderContent params={params} />
		</Suspense>
	);
}

export default MailboxSearchHeader;
