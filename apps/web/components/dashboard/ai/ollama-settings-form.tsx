"use client";

import {
	Button,
	Card,
	NumberInput,
	Select,
	Switch,
	Textarea,
	TextInput,
} from "@mantine/core";
import type { FormState } from "@schema";
import { useActionState, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	listOllamaModels,
	saveAiSettings,
	testAiSettings,
} from "@/lib/actions/dashboard";

type OllamaModel = {
	name: string;
	size?: number;
	parameterSize?: string;
	quantization?: string;
};

type Props = {
	settings: {
		baseUrl: string;
		model: string;
		systemPrompt?: string | null;
		temperature: string | number;
		maxTokens: number;
		enabled: boolean;
	};
	initialModels: OllamaModel[];
};

const formatSize = (bytes?: number) => {
	if (!bytes) return "";
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

export default function OllamaSettingsForm({ settings, initialModels }: Props) {
	const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
	const [model, setModel] = useState(settings.model);
	const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt ?? "");
	const [temperature, setTemperature] = useState(
		Number(settings.temperature ?? 0.4),
	);
	const [maxTokens, setMaxTokens] = useState(settings.maxTokens ?? 700);
	const [enabled, setEnabled] = useState(settings.enabled);
	const [models, setModels] = useState<OllamaModel[]>(initialModels);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const [isTesting, setIsTesting] = useState(false);
	const [testResponse, setTestResponse] = useState("");

	const [formState, formAction, isSaving] = useActionState<FormState, FormData>(
		saveAiSettings,
		{},
	);

	useEffect(() => {
		if (formState.error) {
			toast.error("Could not save AI settings", {
				description: formState.error,
			});
		} else if (formState.success) {
			toast.success(formState.message || "AI settings saved");
		}
	}, [formState]);

	const modelOptions = useMemo(() => {
		const names = new Set<string>();
		const rows = models.map((m) => {
			names.add(m.name);
			const meta = [m.parameterSize, m.quantization, formatSize(m.size)]
				.filter(Boolean)
				.join(" · ");
			return { value: m.name, label: meta ? `${m.name} (${meta})` : m.name };
		});
		if (model && !names.has(model))
			rows.unshift({ value: model, label: model });
		return rows;
	}, [models, model]);

	const handleLoadModels = async () => {
		setIsLoadingModels(true);
		try {
			const result = await listOllamaModels(baseUrl);
			if (!result.success) {
				toast.error("Could not load models", { description: result.error });
				return;
			}
			const loaded = ((result.data as { models?: OllamaModel[] })?.models ||
				[]) as OllamaModel[];
			setModels(loaded);
			if (loaded.length > 0 && !loaded.some((m) => m.name === model)) {
				setModel(loaded[0].name);
			}
			toast.success(
				`Loaded ${loaded.length} Ollama model${loaded.length === 1 ? "" : "s"}`,
			);
		} finally {
			setIsLoadingModels(false);
		}
	};

	const handleTest = async () => {
		setIsTesting(true);
		setTestResponse("");
		try {
			const result = await testAiSettings({
				baseUrl,
				model,
				temperature,
				maxTokens: Math.min(maxTokens, 160),
			});
			if (!result.success) {
				toast.error("Ollama test failed", { description: result.error });
				return;
			}
			const response = String(
				(result.data as { response?: string })?.response || "",
			);
			setTestResponse(response);
			toast.success(result.message || "Ollama test successful");
		} finally {
			setIsTesting(false);
		}
	};

	return (
		<Card className="shadow-none mt-4 !rounded-2xl border">
			<form action={formAction} className="flex flex-col gap-5 p-4">
				<div className="flex flex-col gap-1">
					<h2 className="text-sm font-semibold text-foreground">
						Ollama reply assistant
					</h2>
					<p className="text-xs text-muted-foreground max-w-prose">
						Kurrier uses this local Ollama endpoint for reply drafts. The draft
						is inserted into the editor only; it is never sent automatically.
					</p>
				</div>

				<input type="hidden" name="enabled" value={enabled ? "on" : ""} />

				<Switch
					checked={enabled}
					onChange={(event) => setEnabled(event.currentTarget.checked)}
					label="Enable AI draft button"
				/>

				<div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
					<TextInput
						name="baseUrl"
						label="Ollama base URL"
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.currentTarget.value)}
						placeholder="http://10.0.252.12:11434"
						required
					/>
					<div className="flex items-end gap-2">
						<Select
							name="model"
							label="Model"
							data={modelOptions}
							value={model}
							onChange={(value) => value && setModel(value)}
							searchable
							required
							className="flex-1"
						/>
						<Button
							type="button"
							variant="light"
							loading={isLoadingModels}
							onClick={handleLoadModels}
						>
							Load models
						</Button>
					</div>
				</div>

				<div className="grid gap-4 md:grid-cols-2">
					<NumberInput
						name="temperature"
						label="Temperature"
						value={temperature}
						onChange={(value) => setTemperature(Number(value ?? 0.4))}
						min={0}
						max={2}
						step={0.1}
					/>
					<NumberInput
						name="maxTokens"
						label="Max reply tokens"
						value={maxTokens}
						onChange={(value) => setMaxTokens(Number(value ?? 700))}
						min={64}
						max={4096}
						step={64}
					/>
				</div>

				<Textarea
					name="systemPrompt"
					label="Default instruction"
					value={systemPrompt}
					onChange={(event) => setSystemPrompt(event.currentTarget.value)}
					placeholder="Example: Antworte standardmäßig prägnant, freundlich und auf Deutsch. Keine Fakten erfinden."
					autosize
					minRows={3}
					maxRows={8}
				/>

				{testResponse ? (
					<div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
						<div className="mb-1 text-xs font-medium">Test response</div>
						{testResponse}
					</div>
				) : null}

				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="light"
						loading={isTesting}
						onClick={handleTest}
						disabled={!baseUrl || !model}
					>
						Test connection
					</Button>
					<Button type="submit" loading={isSaving}>
						Save settings
					</Button>
				</div>
			</form>
		</Card>
	);
}
