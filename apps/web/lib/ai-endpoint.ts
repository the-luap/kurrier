import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getServerEnv } from "@schema";
import { isMetadataOrLinkLocalAddress } from "@/lib/safe-url";

// AI endpoints are user supplied and fetched from the web server. Local and
// LAN hosts are legitimate (Ollama / LM Studio usually run there), but
// cloud metadata endpoints, credentials in the URL and redirects are not.

/**
 * Stable error codes. Server actions return these instead of raw messages;
 * the client translates them via the "ai.errors" dictionary namespace.
 */
export const AI_ERROR_CODES = [
	"notSignedIn",
	"invalidUrl",
	"urlProtocol",
	"urlCredentials",
	"urlQuery",
	"urlNotAllowed",
	"hostUnresolved",
	"redirect",
	"httpError",
	"invalidResponse",
	"providerError",
	"unreachable",
	"emptySuggestion",
	"modelRequired",
	"temperatureRange",
	"maxTokensRange",
	"disabled",
	"noModel",
	"generic",
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export class AiError extends Error {
	readonly code: AiErrorCode;
	constructor(code: AiErrorCode) {
		super(code);
		this.name = "AiError";
		this.code = code;
	}
}

/** Error code to return to the client; anything unexpected stays generic. */
export const toAiErrorCode = (
	error: unknown,
	fallback: AiErrorCode = "generic",
): AiErrorCode => (error instanceof AiError ? error.code : fallback);

const BLOCKED_HOSTNAMES = new Set([
	"metadata.google.internal",
	"metadata.goog",
	"metadata",
]);

// Also covers IPv4-mapped IPv6 in hex form ([::ffff:a9fe:a9fe] is how the
// URL parser normalises [::ffff:169.254.169.254]).
const isLinkLocalOrUnspecified = (address: string) =>
	isMetadataOrLinkLocalAddress(address);

const toComparableUrl = (url: URL) =>
	`${url.origin}${url.pathname}`.replace(/\/+$/, "");

/**
 * Validate a user supplied AI base URL and return it without trailing
 * slashes. With resolveHost=false (used when saving) a hostname is not
 * resolved, so settings can be saved while the AI host is offline; the
 * address check runs again before every request.
 */
export async function normalizeAiBaseUrl(
	value: string,
	{ resolveHost = true }: { resolveHost?: boolean } = {},
): Promise<string> {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new AiError("invalidUrl");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new AiError("urlProtocol");
	}
	if (url.username || url.password) {
		throw new AiError("urlCredentials");
	}
	if (url.search || url.hash) {
		throw new AiError("urlQuery");
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (BLOCKED_HOSTNAMES.has(hostname)) {
		throw new AiError("urlNotAllowed");
	}

	if (!resolveHost && !isIP(hostname)) {
		return toComparableUrl(url);
	}

	const addresses = isIP(hostname)
		? [hostname]
		: await lookup(hostname, { all: true })
				.then((results) => results.map((r) => r.address))
				.catch(() => {
					throw new AiError("hostUnresolved");
				});
	if (addresses.some(isLinkLocalOrUnspecified)) {
		throw new AiError("urlNotAllowed");
	}

	return toComparableUrl(url);
}

export const normalizeSavedAiUrl = (value: string) => {
	try {
		return toComparableUrl(new URL(value.trim()));
	} catch {
		return value.trim().replace(/\/+$/, "");
	}
};

/** fetch() that never follows redirects and always expects JSON. */
export async function fetchAiEndpoint(url: string, init: RequestInit) {
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			redirect: "manual",
			cache: "no-store",
		});
	} catch {
		throw new AiError("unreachable");
	}
	if (
		response.type === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400)
	) {
		throw new AiError("redirect");
	}
	if (!response.ok) {
		throw new AiError("httpError");
	}
	try {
		return (await response.json()) as unknown;
	} catch {
		throw new AiError("invalidResponse");
	}
}

export const aiAuthHeaders = (
	apiKey?: string | null,
): Record<string, string> =>
	apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};

/**
 * A stored API key is only ever sent to the base URL it was saved for.
 * A key typed into the form is used as is.
 */
export const resolveAiApiKey = (
	submittedKey: string | null | undefined,
	saved: { baseUrl: string; apiKey: string | null } | null | undefined,
	normalizedBaseUrl: string,
) => {
	if (submittedKey?.trim()) return submittedKey.trim();
	if (
		saved?.apiKey &&
		normalizeSavedAiUrl(saved.baseUrl) === normalizedBaseUrl
	) {
		return saved.apiKey;
	}
	return null;
};

export type AiProvider = "ollama" | "lmstudio";

export const isAiProvider = (value: unknown): value is AiProvider =>
	value === "ollama" || value === "lmstudio";

export const toAiProvider = (value: unknown): AiProvider =>
	isAiProvider(value) ? value : "ollama";

export const aiProviderLabel = (provider: AiProvider) =>
	provider === "lmstudio" ? "LM Studio" : "Ollama";

/** Localhost defaults; OLLAMA_BASE_URL / OLLAMA_MODEL override Ollama's. */
export const getAiDefaults = (provider: AiProvider) => {
	if (provider === "lmstudio") {
		return { baseUrl: "http://localhost:1234/v1", model: "" };
	}
	const { OLLAMA_BASE_URL, OLLAMA_MODEL } = getServerEnv();
	return {
		baseUrl: OLLAMA_BASE_URL?.trim() || "http://localhost:11434",
		model: OLLAMA_MODEL?.trim() || "gemma3:12b",
	};
};

export type AiModelInfo = {
	name: string;
	size: number;
	parameterSize: string;
	quantization: string;
};

export async function fetchAiModels({
	provider,
	baseUrl,
	apiKey,
}: {
	provider: AiProvider;
	baseUrl: string;
	apiKey?: string | null;
}): Promise<AiModelInfo[]> {
	if (provider === "lmstudio") {
		const data = (await fetchAiEndpoint(`${baseUrl}/models`, {
			method: "GET",
			headers: aiAuthHeaders(apiKey),
			signal: AbortSignal.timeout(10_000),
		})) as { data?: Array<{ id?: string }> };

		return (Array.isArray(data?.data) ? data.data : [])
			.map((model) => ({
				name: String(model?.id || ""),
				size: 0,
				parameterSize: "",
				quantization: "",
			}))
			.filter((model) => model.name);
	}

	const data = (await fetchAiEndpoint(`${baseUrl}/api/tags`, {
		method: "GET",
		headers: aiAuthHeaders(apiKey),
		signal: AbortSignal.timeout(10_000),
	})) as {
		models?: Array<{
			name?: string;
			model?: string;
			size?: number;
			details?: { parameter_size?: string; quantization_level?: string };
		}>;
	};

	return (Array.isArray(data?.models) ? data.models : [])
		.map((model) => ({
			name: String(model?.name || model?.model || ""),
			size: Number(model?.size || 0),
			parameterSize: String(model?.details?.parameter_size || ""),
			quantization: String(model?.details?.quantization_level || ""),
		}))
		.filter((model) => model.name);
}

/**
 * Run one non-streaming prompt against Ollama (/api/generate) or an
 * OpenAI-compatible LM Studio server (/chat/completions) and return the
 * trimmed text.
 */
export async function runAiPrompt({
	provider,
	baseUrl,
	apiKey,
	model,
	prompt,
	temperature,
	maxTokens,
	timeoutMs = 60_000,
}: {
	provider: AiProvider;
	baseUrl: string;
	apiKey?: string | null;
	model: string;
	prompt: string;
	temperature: number;
	maxTokens: number;
	timeoutMs?: number;
}): Promise<string> {
	const headers = {
		"Content-Type": "application/json",
		...aiAuthHeaders(apiKey),
	};

	if (provider === "lmstudio") {
		const data = (await fetchAiEndpoint(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				stream: false,
				temperature,
				max_tokens: maxTokens,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		})) as {
			choices?: Array<{ message?: { content?: string } }>;
			error?: unknown;
		};
		if (data?.error) throw new AiError("providerError");
		return String(data?.choices?.[0]?.message?.content || "").trim();
	}

	const data = (await fetchAiEndpoint(`${baseUrl}/api/generate`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			prompt,
			stream: false,
			options: { temperature, num_predict: maxTokens },
		}),
		signal: AbortSignal.timeout(timeoutMs),
	})) as { response?: string; error?: unknown };
	if (data?.error) throw new AiError("providerError");
	return String(data?.response || "").trim();
}

/** Plain text of an HTML body for the prompt, capped at 6000 chars. */
export const stripHtmlForPrompt = (value?: string | null) =>
	(value || "")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&amp;/gi, "&")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, 6000);
