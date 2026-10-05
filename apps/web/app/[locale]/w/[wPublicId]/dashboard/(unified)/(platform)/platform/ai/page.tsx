import { Container } from "@/components/common/containers";
import AiSettingsForm from "@/components/dashboard/ai/ai-settings-form";
import DashboardPageHeader from "@/components/dashboard/dashboard-page-header";
import { fetchAiSettings } from "@/lib/actions/ai";
import { getDictionary, type Locale } from "@/lib/dictionaries";

export default async function AiSettingsPage({
	params,
}: {
	params: Promise<{ locale: Locale; wPublicId: string }>;
}) {
	const { locale } = await params;
	// Only the database is read here. Models are loaded client-side by the
	// form: the AI host may be slow or unreachable and must not block render.
	const [dict, settings] = await Promise.all([
		getDictionary(locale),
		fetchAiSettings(),
	]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<DashboardPageHeader title={dict.ai.pageTitle} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<Container variant="wide" className="py-6 sm:py-8">
					<p className="mb-6 max-w-prose text-sm leading-6 text-muted-foreground">
						{dict.ai.pageDescription}
					</p>
					<AiSettingsForm settings={settings} />
				</Container>
			</div>
		</div>
	);
}
