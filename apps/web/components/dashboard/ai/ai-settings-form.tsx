"use client";

import {
	Button,
	Card,
	Checkbox,
	NumberInput,
	PasswordInput,
	Select,
	Switch,
	Textarea,
	TextInput,
} from "@mantine/core";
import type { FormState } from "@schema";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	aiErrorText,
	aiProviderName,
	fillAi,
	useAiDict,
} from "@/components/dashboard/ai/ai-i18n";
import {
	type AiSettingsView,
	listAiModels,
	saveAiSettings,
	testAiSettings,
} from "@/lib/actions/ai";

type AiProviderId = AiSettingsView["provider"];

type AiModel = {
	name: string;
	size?: number;
	parameterSize?: string;
	quantization?: string;
};

const formatSize = (bytes?: number) =>
	bytes ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : "";

const toProvider = (value: string | null): AiProviderId =>
	value === "lmstudio" ? "lmstudio" : "ollama";

export default function AiSettingsForm({
	settings,
}: {
	settings: AiSettingsView;
}) {
	const dict = useAiDict();
	const savedProvider = settings.provider;
	const savedValues = { baseUrl: settings.baseUrl, model: settings.model };

	const [provider, setProvider] = useState<AiProviderId>(savedProvider);
	const [baseUrl, setBaseUrl] = useState(savedValues.baseUrl);
	const [model, setModel] = useState(savedValues.model);
	const [apiKey, setApiKey] = useState("");
	const [clearApiKey, setClearApiKey] = useState(false);
	const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
	const [temperature, setTemperature] = useState(settings.temperature);
	const [maxTokens, setMaxTokens] = useState(settings.maxTokens);
	const [enabled, setEnabled] = useState(settings.enabled);
	const [models, setModels] = useState<AiModel[]>([]);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const [isTesting, setIsTesting] = useState(false);
	const [testResponse, setTestResponse] = useState("");

	const [formState, formAction, isSaving] = useActionState<FormState, FormData>(
		saveAiSettings,
		{},
	);

	// Toast each save result once.
	const handledStateRef = useRef<FormState | null>(null);
	useEffect(() => {
		if (handledStateRef.current === formState) return;
		handledStateRef.current = formState;
		if (formState.error) {
			toast.error(dict.form.saveFailed, {
				description: aiErrorText(
					dict,
					formState.error,
					aiProviderName(provider),
				),
			});
		} else if (formState.success) {
			setApiKey("");
			setClearApiKey(false);
			toast.success(dict.form.saved);
		}
	}, [formState, dict, provider]);

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

	const handleLoadModels = async ({ silent = false } = {}) => {
		const label = aiProviderName(provider);
		setIsLoadingModels(true);
		try {
			const result = await listAiModels({ provider, baseUrl, apiKey });
			if (!result.success) {
				if (!silent) {
					toast.error(dict.form.modelsFailed, {
						description: aiErrorText(dict, result.error, label),
					});
				}
				return;
			}
			const loaded = result.data?.models ?? [];
			setModels(loaded);
			if (loaded.length > 0 && !loaded.some((m) => m.name === model)) {
				setModel(loaded[0].name);
			}
			if (!silent) {
				toast.success(
					fillAi(dict.form.modelsLoaded, {
						provider: label,
						count: loaded.length,
					}),
				);
			}
		} catch {
			if (!silent) {
				toast.error(dict.form.modelsFailed, {
					description: aiErrorText(dict, "generic", label),
				});
			}
		} finally {
			setIsLoadingModels(false);
		}
	};

	// The page renders without contacting the AI host (it may be offline or
	// slow); fetch the model list once after mount for saved settings.
	const autoLoadedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; uses the initial saved settings
	useEffect(() => {
		if (autoLoadedRef.current) return;
		autoLoadedRef.current = true;
		if (settings.configured && settings.baseUrl) {
			void handleLoadModels({ silent: true });
		}
	}, []);

	const handleTest = async () => {
		const label = aiProviderName(provider);
		setIsTesting(true);
		setTestResponse("");
		try {
			const result = await testAiSettings({
				provider,
				baseUrl,
				model,
				apiKey,
				temperature,
				maxTokens: Math.min(maxTokens, 160),
			});
			if (!result.success) {
				toast.error(dict.form.testFailed, {
					description: aiErrorText(dict, result.error, label),
				});
				return;
			}
			setTestResponse(result.data?.response ?? "");
			toast.success(fillAi(dict.form.testOk, { provider: label }));
		} catch {
			toast.error(dict.form.testFailed, {
				description: aiErrorText(dict, "generic", label),
			});
		} finally {
			setIsTesting(false);
		}
	};

	const handleProviderChange = (value: string | null) => {
		const next = toProvider(value);
		if (next === provider) return;
		setProvider(next);
		// Switching back to the saved provider restores its saved values.
		const values =
			next === savedProvider ? savedValues : settings.defaults[next];
		setBaseUrl(values.baseUrl);
		setModel(values.model);
		setModels([]);
		setApiKey("");
		setClearApiKey(false);
		setTestResponse("");
	};

	// The saved-token hint only applies to the provider the token belongs to.
	const hasSavedKey = settings.hasApiKey && provider === savedProvider;

	return (
		<Card className="!rounded-2xl border shadow-none">
			<form action={formAction} className="flex flex-col gap-5 p-1 sm:p-2">
				<div className="flex flex-col gap-1">
					<h2 className="text-sm font-semibold text-foreground">
						{dict.form.title}
					</h2>
					<p className="max-w-prose text-xs text-muted-foreground">
						{dict.form.description}
					</p>
				</div>

				<input type="hidden" name="enabled" value={enabled ? "on" : ""} />
				<input type="hidden" name="provider" value={provider} />

				<Switch
					checked={enabled}
					onChange={(event) => setEnabled(event.currentTarget.checked)}
					label={dict.form.enable}
				/>

				<div className="grid gap-4 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
					<Select
						label={dict.form.provider}
						data={[
							{ value: "ollama", label: "Ollama" },
							{ value: "lmstudio", label: "LM Studio" },
						]}
						value={provider}
						onChange={handleProviderChange}
						allowDeselect={false}
					/>
					<TextInput
						name="baseUrl"
						label={dict.form.baseUrl}
						description={dict.form.baseUrlHint}
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.currentTarget.value)}
						placeholder={settings.defaults[provider].baseUrl}
						required
					/>
					<div className="flex items-end gap-2">
						<Select
							name="model"
							label={dict.form.model}
							data={modelOptions}
							value={model || null}
							onChange={(value) => value && setModel(value)}
							searchable
							required
							className="min-w-0 flex-1"
						/>
						<Button
							type="button"
							variant="light"
							loading={isLoadingModels}
							disabled={!baseUrl}
							onClick={() => handleLoadModels()}
						>
							{dict.form.loadModels}
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-2">
					<PasswordInput
						name="apiKey"
						label={dict.form.apiKeyLabel}
						description={
							hasSavedKey ? dict.form.apiKeySavedHint : dict.form.apiKeyHint
						}
						value={apiKey}
						onChange={(event) => setApiKey(event.currentTarget.value)}
						placeholder={hasSavedKey ? dict.form.apiKeySavedPlaceholder : ""}
						autoComplete="off"
					/>
					{hasSavedKey ? (
						<Checkbox
							name="clearApiKey"
							checked={clearApiKey}
							onChange={(event) => setClearApiKey(event.currentTarget.checked)}
							label={dict.form.clearApiKey}
						/>
					) : null}
				</div>

				<div className="grid gap-4 md:grid-cols-2">
					<NumberInput
						name="temperature"
						label={dict.form.temperature}
						value={temperature}
						onChange={(value) => setTemperature(Number(value ?? 0.4))}
						min={0}
						max={2}
						step={0.1}
						decimalScale={2}
					/>
					<NumberInput
						name="maxTokens"
						label={dict.form.maxTokens}
						value={maxTokens}
						onChange={(value) => setMaxTokens(Number(value ?? 700))}
						min={64}
						max={4096}
						step={64}
						allowDecimal={false}
					/>
				</div>

				<Textarea
					name="systemPrompt"
					label={dict.form.systemPrompt}
					value={systemPrompt}
					onChange={(event) => setSystemPrompt(event.currentTarget.value)}
					placeholder={dict.form.systemPromptPlaceholder}
					maxLength={4000}
					autosize
					minRows={3}
					maxRows={8}
				/>

				{testResponse ? (
					<div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
						<div className="mb-1 text-xs font-medium">
							{dict.form.testResponse}
						</div>
						<p className="whitespace-pre-wrap break-words">{testResponse}</p>
					</div>
				) : null}

				<div className="flex flex-wrap justify-end gap-2">
					<Button
						type="button"
						variant="light"
						loading={isTesting}
						onClick={handleTest}
						disabled={!baseUrl || !model}
					>
						{dict.form.test}
					</Button>
					<Button type="submit" loading={isSaving}>
						{dict.form.save}
					</Button>
				</div>
			</form>
		</Card>
	);
}
