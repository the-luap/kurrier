import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

export async function normalizeAiBaseUrl(value: string): Promise<string> {
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

	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

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
	if (
		saved?.apiKey &&
		saved.baseUrl.trim().replace(/\/+$/, "") === normalizedBaseUrl
	) {
		return saved.apiKey;
	}
	return null;
};
