"use server";

import {
	createSecret,
	deleteSecret,
	getSecret,
	messages,
	secretsMeta,
	updateSecret,
	type UserAiSettingsEntity,
	userAiSettings,
} from "@db";
import type { FormState } from "@schema";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { isSignedIn } from "@/lib/actions/auth";
import { readSessionToken as currentSession } from "@/lib/auth-session";
import { getWorkspaceId, rlsClient } from "@/lib/actions/clients";
import { mailboxVisibleSql } from "@/lib/actions/authz";
import {
	AiError,
	type AiModelInfo,
	type AiProvider,
	aiProviderLabel,
	fetchAiModels,
	getAiDefaults,
	isAiProvider,
	normalizeAiBaseUrl,
	resolveAiApiKey,
	runAiPrompt,
	stripHtmlForPrompt,
	toAiErrorCode,
	toAiProvider,
} from "@/lib/ai-endpoint";

// All AI actions return stable error codes (see AI_ERROR_CODES in
// lib/ai-endpoint.ts) in `error`; the client translates them. Unexpected
// errors (database, vault, network internals) are never passed through.

const DEFAULT_AI_PROVIDER: AiProvider = "ollama";

const fail = (error: unknown) =>
	({ success: false, error: toAiErrorCode(error) }) as FormState;

const requireUserId = async () => {
	const user = await isSignedIn();
	if (!user?.id) throw new AiError("notSignedIn");
	return String(user.id);
};

const aiSecretName = (ownerId: string, provider: AiProvider) =>
	`ai:${ownerId}:${provider}`;

const toBaseUrl = (
	provider: AiProvider,
	value: string | null | undefined,
	opts?: { resolveHost?: boolean },
) =>
	normalizeAiBaseUrl(
		String(value ?? "").trim() || getAiDefaults(provider).baseUrl,
		opts,
	);

/** The user's row for one provider, or the most recently saved one. */
const loadSettingsRow = async (
	provider?: AiProvider,
): Promise<UserAiSettingsEntity | undefined> => {
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		provider
			? tx
					.select()
					.from(userAiSettings)
					.where(eq(userAiSettings.provider, provider))
					.limit(1)
			: tx
					.select()
					.from(userAiSettings)
					.orderBy(desc(userAiSettings.updatedAt))
					.limit(1),
	);
	return row;
};

/**
 * Decrypted API key of a settings row: the vault secret, or the legacy
 * plaintext column of rows carried over from the v3 fork.
 */
const readStoredApiKey = async (
	row: UserAiSettingsEntity | undefined,
	userId: string,
): Promise<string | null> => {
	if (!row) return null;
	if (row.apiKeySecretId) {
		try {
			const session = await currentSession();
			const workspaceId = await getWorkspaceId();
			const { metaSecret, vault } = await getSecret(
				session,
				row.apiKeySecretId,
				workspaceId,
			);
			// secrets_meta is visible workspace-wide; only use our own secret.
			if (
				String(metaSecret.ownerId) !== userId ||
				metaSecret.name !== aiSecretName(userId, toAiProvider(row.provider))
			) {
				return null;
			}
			return vault.decrypted_secret || null;
		} catch {
			return null;
		}
	}
	return row.apiKey?.trim() || null;
};

const savedForKeyCheck = async (
	row: UserAiSettingsEntity | undefined,
	userId: string,
) =>
	row
		? { baseUrl: row.baseUrl, apiKey: await readStoredApiKey(row, userId) }
		: null;

/**
 * Store (or remove) the API key in the vault and return the secret id to
 * reference from user_ai_settings.
 */
const storeApiKey = async ({
	userId,
	provider,
	apiKey,
	existingSecretId,
}: {
	userId: string;
	provider: AiProvider;
	apiKey: string | null;
	existingSecretId: string | null;
}): Promise<string | null> => {
	if (!apiKey) return null;
	const session = await currentSession();
	const workspaceId = await getWorkspaceId();
	const name = aiSecretName(userId, provider);
	const description = `${aiProviderLabel(provider)} API key for AI reply drafts`;

	if (existingSecretId) {
		try {
			await updateSecret(session, workspaceId, existingSecretId, {
				value: apiKey,
			});
			return existingSecretId;
		} catch {
			// Secret gone; fall through and create or reuse by name.
		}
	}

	// A secret with this name can be left over (e.g. the row was reset);
	// names are unique per workspace, so reuse it.
	const rls = await rlsClient();
	const [orphan] = await rls((tx) =>
		tx
			.select({ id: secretsMeta.id })
			.from(secretsMeta)
			.where(and(eq(secretsMeta.name, name), eq(secretsMeta.ownerId, userId)))
			.limit(1),
	);
	if (orphan?.id) {
		await updateSecret(session, workspaceId, String(orphan.id), {
			value: apiKey,
			description,
		});
		return String(orphan.id);
	}

	const created = await createSecret(session, workspaceId, {
		name,
		value: apiKey,
		description,
		managedBy: "system",
	});
	return String(created.id);
};

export type AiSettingsView = {
	id: string;
	configured: boolean;
	provider: AiProvider;
	baseUrl: string;
	model: string;
	systemPrompt: string;
	temperature: number;
	maxTokens: number;
	enabled: boolean;
	hasApiKey: boolean;
	defaults: Record<AiProvider, { baseUrl: string; model: string }>;
};

/** Settings for the settings page. Never contains the API key. */
export async function fetchAiSettings(): Promise<AiSettingsView> {
	const settings = await loadSettingsRow();
	const provider = settings
		? toAiProvider(settings.provider)
		: DEFAULT_AI_PROVIDER;
	const defaults = {
		ollama: getAiDefaults("ollama"),
		lmstudio: getAiDefaults("lmstudio"),
	};

	return {
		id: settings?.id ?? "",
		configured: Boolean(settings),
		provider,
		baseUrl: settings?.baseUrl ?? defaults[provider].baseUrl,
		model: settings?.model ?? defaults[provider].model,
		systemPrompt: settings?.systemPrompt ?? "",
		temperature: Number(settings?.temperature ?? 0.4),
		maxTokens: settings?.maxTokens ?? 700,
		// AI stays off until the user has saved a configuration.
		enabled: settings?.enabled ?? false,
		hasApiKey: Boolean(settings?.apiKeySecretId || settings?.apiKey),
		defaults,
	};
}

/** Whether the composer should show the AI draft panel. */
export async function fetchAiDraftStatus(): Promise<{ enabled: boolean }> {
	try {
		const settings = await loadSettingsRow();
		return { enabled: Boolean(settings?.enabled && settings.model) };
	} catch {
		return { enabled: false };
	}
}

export async function listAiModels(input: {
	provider?: string;
	baseUrl: string;
	apiKey?: string;
}): Promise<FormState<{ models: AiModelInfo[] }>> {
	try {
		const userId = await requireUserId();
		const provider = isAiProvider(input?.provider)
			? input.provider
			: DEFAULT_AI_PROVIDER;
		const baseUrl = await toBaseUrl(provider, input?.baseUrl);
		const saved = await loadSettingsRow(provider);
		const models = await fetchAiModels({
			provider,
			baseUrl,
			apiKey: resolveAiApiKey(
				input?.apiKey,
				await savedForKeyCheck(saved, userId),
				baseUrl,
			),
		});
		return { success: true, data: { models } };
	} catch (error) {
		return fail(error) as FormState<{ models: AiModelInfo[] }>;
	}
}

export async function saveAiSettings(
	_prev: FormState,
	formData: FormData,
): Promise<FormState> {
	try {
		const userId = await requireUserId();
		const rawProvider = String(formData.get("provider") ?? "");
		const provider = isAiProvider(rawProvider)
			? rawProvider
			: DEFAULT_AI_PROVIDER;
		const defaults = getAiDefaults(provider);
		// No DNS lookup here: saving must work while the AI host is offline.
		const baseUrl = await toBaseUrl(
			provider,
			String(formData.get("baseUrl") ?? ""),
			{ resolveHost: false },
		);
		const model = String(formData.get("model") ?? defaults.model)
			.trim()
			.slice(0, 200);
		const submittedApiKey = String(formData.get("apiKey") ?? "").trim();
		const clearApiKey = formData.get("clearApiKey") === "on";
		const systemPrompt = String(formData.get("systemPrompt") ?? "")
			.trim()
			.slice(0, 4000);
		const temperature = Number(formData.get("temperature") ?? 0.4);
		const maxTokens = Number(formData.get("maxTokens") ?? 700);
		const enabled = formData.get("enabled") === "on";

		if (!model) throw new AiError("modelRequired");
		if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
			throw new AiError("temperatureRange");
		}
		if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 4096) {
			throw new AiError("maxTokensRange");
		}

		const existing = await loadSettingsRow(provider);
		// Keep the stored key only while the base URL stays the same.
		const apiKey = clearApiKey
			? null
			: resolveAiApiKey(
					submittedApiKey,
					await savedForKeyCheck(existing, userId),
					baseUrl,
				);

		const previousSecretId = existing?.apiKeySecretId
			? String(existing.apiKeySecretId)
			: null;
		const apiKeySecretId = await storeApiKey({
			userId,
			provider,
			apiKey,
			existingSecretId: previousSecretId,
		});

		const values = {
			baseUrl,
			model,
			// Legacy plaintext column: migrated into the vault, always cleared.
			apiKey: null,
			apiKeySecretId,
			systemPrompt: systemPrompt || null,
			temperature: String(temperature),
			maxTokens,
			enabled,
		};

		const rls = await rlsClient();
		await rls((tx) =>
			tx
				.insert(userAiSettings)
				.values({ ownerId: userId, provider, ...values })
				.onConflictDoUpdate({
					target: [
						userAiSettings.workspaceId,
						userAiSettings.ownerId,
						userAiSettings.provider,
					],
					set: { ...values, updatedAt: new Date() },
				}),
		);

		// The key was removed (or the base URL changed): drop the old secret.
		if (previousSecretId && previousSecretId !== apiKeySecretId) {
			try {
				const session = await currentSession();
				await deleteSecret(session, previousSecretId, await getWorkspaceId());
			} catch {
				// Unreferenced secret; harmless.
			}
		}

		revalidatePath(
			"/[locale]/w/[wPublicId]/dashboard/(unified)/(platform)/platform/ai",
			"page",
		);
		return { success: true, message: "saved" };
	} catch (error) {
		return fail(error);
	}
}

export async function testAiSettings(input: {
	provider?: string;
	baseUrl: string;
	model: string;
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
}): Promise<FormState<{ response: string }>> {
	try {
		const userId = await requireUserId();
		const provider = isAiProvider(input?.provider)
			? input.provider
			: DEFAULT_AI_PROVIDER;
		const model = String(input?.model ?? "").trim();
		if (!model) throw new AiError("modelRequired");
		const baseUrl = await toBaseUrl(provider, input?.baseUrl);
		const saved = await loadSettingsRow(provider);
		const apiKey = resolveAiApiKey(
			input?.apiKey,
			await savedForKeyCheck(saved, userId),
			baseUrl,
		);
		const temperature = Number(input?.temperature ?? 0.2);
		const maxTokens = Number(input?.maxTokens ?? 80);
		const response = await runAiPrompt({
			provider,
			baseUrl,
			apiKey,
			model,
			prompt:
				"Reply with one short sentence confirming that Kurrier AI is ready.",
			temperature:
				Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
					? temperature
					: 0.2,
			maxTokens:
				Number.isInteger(maxTokens) && maxTokens >= 16 && maxTokens <= 4096
					? maxTokens
					: 80,
			timeoutMs: 30_000,
		});
		if (!response) throw new AiError("emptySuggestion");
		return { success: true, data: { response: response.slice(0, 2000) } };
	} catch (error) {
		return fail(error) as FormState<{ response: string }>;
	}
}

export type AiReplySuggestionInput = {
	mode?: "reply" | "forward" | "compose" | string;
	userInstruction?: string;
	currentHtml?: string;
	/** The original message is loaded server-side, through RLS. */
	originalMessageId?: string | null;
};

export async function generateAiReplySuggestion(
	input: AiReplySuggestionInput,
): Promise<FormState<{ suggestion?: string; provider?: string }>> {
	let providerLabel = "";
	try {
		const userId = await requireUserId();
		const originalMessageId = String(input?.originalMessageId ?? "").trim();

		const rls = await rlsClient();
		const { settings, original } = await rls(async (tx) => {
			const [settings] = await tx
				.select()
				.from(userAiSettings)
				.orderBy(desc(userAiSettings.updatedAt))
				.limit(1);
			if (!settings?.enabled || !originalMessageId) {
				return { settings, original: undefined };
			}
			const [original] = await tx
				.select({
					text: messages.text,
					html: messages.html,
					subject: messages.subject,
					from: messages.from,
				})
				.from(messages)
				.where(
					and(
						eq(messages.id, originalMessageId),
						mailboxVisibleSql(messages.mailboxId),
					),
				)
				.limit(1);
			return { settings, original };
		});

		if (!settings?.enabled) throw new AiError("disabled");

		const provider = toAiProvider(settings.provider);
		providerLabel = aiProviderLabel(provider);
		const defaults = getAiDefaults(provider);
		const baseUrl = await toBaseUrl(provider, settings.baseUrl);
		const model = settings.model || defaults.model;
		if (!model) throw new AiError("noModel");
		const apiKey = await readStoredApiKey(settings, userId);

		const mode = ["reply", "forward", "compose"].includes(String(input?.mode))
			? String(input.mode)
			: "reply";
		const systemPrompt = (settings.systemPrompt || "").trim();
		const temperature = Number(settings.temperature ?? 0.4);
		const maxTokens = Number(settings.maxTokens ?? 700);
		const originalText = stripHtmlForPrompt(
			original?.text || original?.html || "",
		);
		const originalFrom = original?.from?.text || "";
		const currentDraft = stripHtmlForPrompt(input?.currentHtml || "");
		const instruction = String(input?.userInstruction ?? "")
			.trim()
			.slice(0, 1200);

		const prompt = `You are drafting an email inside Kurrier. Return only the proposed email body, no explanations, no subject line.

Mode: ${mode}
Subject: ${original?.subject || "(none)"}
From: ${originalFrom || "(unknown)"}

Default instruction:
${systemPrompt || "Write a concise, helpful, professional reply."}

User instruction / desired tone for this draft:
${instruction || "No extra instruction."}

Current draft, if any:
${currentDraft || "(empty)"}

Original email context:
${originalText || "(no original message context)"}

Rules:
- Match the user's instruction and language.
- Be concise unless the instruction asks for detail.
- Do not invent facts, dates, promises, prices, or attachments.
- Do not include greetings/signature if the current draft already contains them unless needed.
- Output plain text paragraphs only.`;

		const suggestion = await runAiPrompt({
			provider,
			baseUrl,
			apiKey,
			model,
			prompt,
			temperature: Number.isFinite(temperature) ? temperature : 0.4,
			maxTokens: Number.isFinite(maxTokens) ? maxTokens : 700,
		});
		if (!suggestion) throw new AiError("emptySuggestion");
		return { success: true, data: { suggestion } };
	} catch (error) {
		return {
			success: false,
			error: toAiErrorCode(error),
			data: { provider: providerLabel },
		};
	}
}
