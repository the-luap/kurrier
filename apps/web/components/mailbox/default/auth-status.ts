// Parses SPF / DKIM / DMARC results out of a message's stored headers.
// Runs on the server (thread-item.tsx) so the full headers never have to be
// serialized to the client; only the small result object is passed down.

export type AuthResult = "pass" | "fail" | "warn" | "unknown";

export type AuthStatus = {
	spf: AuthResult;
	dkim: AuthResult;
	dmarc: AuthResult;
	authResults: string;
};

function headerToString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "value" in value) {
		return String((value as { value?: unknown }).value ?? "");
	}
	return "";
}

// Only the FIRST (topmost) occurrence is used: that one was added by our own
// receiving server; lower ones may be forged by the sender.
function getFirstHeader(headers: unknown, name: string): string {
	if (!headers || typeof headers !== "object") return "";
	const record = headers as Record<string, unknown>;
	const raw = record[name] ?? record[name.toLowerCase()];
	if (Array.isArray(raw)) return headerToString(raw[0]);
	return headerToString(raw);
}

function classify(value: string | undefined): AuthResult {
	switch (value?.toLowerCase()) {
		case "pass":
			return "pass";
		case "fail":
		case "permerror":
			return "fail";
		case "softfail":
		case "neutral":
		case "temperror":
		case "policy":
			return "warn";
		default:
			// "none" and missing results carry no information.
			return "unknown";
	}
}

function matchMethod(authResults: string, method: string): AuthResult {
	const match = new RegExp(`(?:^|[\\s;])${method}\\s*=\\s*([a-z]+)`, "i").exec(
		authResults,
	);
	return classify(match?.[1]);
}

export function getAuthStatus(headers: unknown): AuthStatus {
	const authResults = getFirstHeader(headers, "authentication-results");
	const receivedSpf = getFirstHeader(headers, "received-spf");

	let spf = matchMethod(authResults, "spf");
	if (spf === "unknown" && receivedSpf) {
		spf = classify(/^\s*([a-z]+)/i.exec(receivedSpf)?.[1]);
	}

	return {
		spf,
		dkim: matchMethod(authResults, "dkim"),
		dmarc: matchMethod(authResults, "dmarc"),
		authResults,
	};
}

export function hasKnownAuthStatus(status: AuthStatus | null | undefined) {
	if (!status) return false;
	return (
		status.spf !== "unknown" ||
		status.dkim !== "unknown" ||
		status.dmarc !== "unknown"
	);
}
