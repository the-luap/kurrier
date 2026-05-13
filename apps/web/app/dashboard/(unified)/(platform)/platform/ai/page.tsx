import { Container } from "@/components/common/containers";
import OllamaSettingsForm from "@/components/dashboard/ai/ollama-settings-form";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { fetchAiSettings, listAiModels } from "@/lib/actions/dashboard";

export default async function AiSettingsPage() {
	const settings = await fetchAiSettings();
	const modelsResult = await listAiModels({
		provider: settings.provider,
		baseUrl: settings.baseUrl,
	});
	const initialModels = modelsResult.success
		? ((modelsResult.data as { models?: [] })?.models ?? [])
		: [];

	return (
		<>
			<header className="flex h-16 shrink-0 items-center gap-2">
				<div className="flex items-center gap-2 px-4">
					<SidebarTrigger className="-ml-1" />
					<Separator
						orientation="vertical"
						className="mr-2 data-[orientation=vertical]:h-4"
					/>
				</div>
			</header>
			<div className="flex flex-1 flex-col gap-4 p-4 pt-0">
				<Container variant="wide">
					<div className="flex items-center justify-between my-4">
						<h1 className="text-xl font-bold text-foreground">AI Provider</h1>
					</div>

					<p className="max-w-prose text-sm text-muted-foreground my-6">
						Configure Ollama or LM Studio for editable AI reply drafts from the
						mail composer.
					</p>

					<OllamaSettingsForm
						settings={settings}
						initialModels={initialModels}
					/>
				</Container>
			</div>
		</>
	);
}
