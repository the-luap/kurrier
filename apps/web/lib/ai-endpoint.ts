import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getServerEnv } from "@schema";

// AI endpoints are user supplied and fetched from the web server. Local and
// LAN hosts are legitimate (Ollama / LM Studio usually run there), but
// cloud metadata endpoints, credentials in the URL and redirects are not.

const BLOCKED_HOSTNAMES = new Set([
	"metadata.google.internal",
	"metadata.goog",
	"metadata",
]);

const isLinkLocalOrUnspecified = (address: string) => {
	const ip = address.toLowerCase().replace(/^::ffff:/, "");
	if (isIP(ip) === 4) {
		return ip.startsWith("169.254.") || ip.startsWith("0.");
	}
	return (
		ip === "::" || /^fe[89ab][0-9a-f]:/.test(ip) || ip.startsWith("fd00:ec2:")
	);
};

export async function normalizeAiBaseUrl(
	value: string,
	{ resolveHost = true }: { resolveHost?: boolean } = {},
): Promise<string> {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Please enter a valid AI base URL.");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("The AI base URL must use http or https.");
	}
	if (url.username || url.password) {
		throw new Error("The AI base URL must not contain credentials.");
	}
	if (url.search || url.hash) {
		throw new Error("The AI base URL must not contain a query or fragment.");
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (BLOCKED_HOSTNAMES.has(hostname)) {
		throw new Error("This AI base URL is not allowed.");
	}

	// Saving settings must work while the AI host is offline; the address
	// check runs again before every request.
	if (!resolveHost && !isIP(hostname)) {
		return toComparableUrl(url);
	}

	const addresses = isIP(hostname)
		? [hostname]
		: await lookup(hostname, { all: true })
				.then((results) => results.map((r) => r.address))
				.catch(() => {
					throw new Error(`AI host ${hostname} could not be resolved.`);
				});
	if (addresses.some(isLinkLocalOrUnspecified)) {
		throw new Error("This AI base URL is not allowed.");
	}

	return toComparableUrl(url);
}

const toComparableUrl = (url: URL) =>
	`${url.origin}${url.pathname}`.replace(/\/+$/, "");

const normalizeSavedUrl = (value: string) => {
	try {
		return toComparableUrl(new URL(value.trim()));
	} catch {
		return value.trim().replace(/\/+$/, "");
	}
};

export async function fetchAiEndpoint(
	url: string,
	init: RequestInit & { label: string },
) {
	const { label, ...rest } = init;
	const response = await fetch(url, { ...rest, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		throw new Error(
			`${label} answered with a redirect, which is not followed.`,
		);
	}
	if (!response.ok) {
		throw new Error(`${label} returned HTTP ${response.status}.`);
	}
	try {
		return (await response.json()) as unknown;
	} catch {
		throw new Error(`${label} did not return a valid JSON response.`);
	}
}

export const aiAuthHeaders = (
	apiKey?: string | null,
): Record<string, string> =>
	apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};

// A stored API key is only ever sent to the base URL it was saved for.
export const resolveAiApiKey = (
	submittedKey: string | null | undefined,
	saved: { baseUrl: string; apiKey: string | null } | null | undefined,
	normalizedBaseUrl: string,
) => {
	if (submittedKey?.trim()) return submittedKey.trim();
	if (saved?.apiKey && normalizeSavedUrl(saved.baseUrl) === normalizedBaseUrl) {
		return saved.apiKey;
	}
	return null;
};

export type AiProvider = "ollama" | "lmstudio";

export const isAiProvider = (value: string): value is AiProvider =>
	value === "ollama" || value === "lmstudio";

export const toAiProvider = (value: unknown): AiProvider =>
	isAiProvider(String(value ?? "")) ? (value as AiProvider) : "ollama";

export const aiProviderLabel = (provider: AiProvider) =>
	provider === "lmstudio" ? "LM Studio" : "Ollama";

export const getAiDefaults = (provider: AiProvider) => {
	if (provider === "lmstudio") {
		return { baseUrl: "http://localhost:1234/v1", model: "" };
	}
	const { OLLAMA_BASE_URL, OLLAMA_MODEL } = getServerEnv();
	return {
		baseUrl: OLLAMA_BASE_URL || "http://localhost:11434",
		model: OLLAMA_MODEL || "gemma3:12b",
	};
};

/**
 * Run one non-streaming prompt against Ollama (/api/generate) or an
 * OpenAI-compatible LM Studio server (/chat/completions) and return the
 * trimmed text. Errors carry the provider label as prefix.
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
	const label = aiProviderLabel(provider);
	const headers = {
		"Content-Type": "application/json",
		...aiAuthHeaders(apiKey),
	};

	if (provider === "lmstudio") {
		const data = (await fetchAiEndpoint(`${baseUrl}/chat/completions`, {
			label,
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
			error?: { message?: string } | string;
		};
		if (data.error) throw new Error(`${label} returned an error.`);
		return String(data.choices?.[0]?.message?.content || "").trim();
	}

	const data = (await fetchAiEndpoint(`${baseUrl}/api/generate`, {
		label,
		method: "POST",
		headers,
		body: JSON.stringify({
			model,
			prompt,
			stream: false,
			options: { temperature, num_predict: maxTokens },
		}),
		signal: AbortSignal.timeout(timeoutMs),
	})) as { response?: string; error?: string };
	if (data.error) throw new Error(`${label} returned an error.`);
	return String(data.response || "").trim();
}
