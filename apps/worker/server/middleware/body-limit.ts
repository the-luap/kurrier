import { createError, defineEventHandler, getRequestHeader } from "h3";

/**
 * Rejects oversized request bodies on the public API / webhook routes before
 * any handler buffers them into memory (readRawBody, readBody and
 * readMultipartFormData have no limit of their own).
 *
 * MAX_REQUEST_BODY_MB (default 50) — large enough for a 25 MB attachment
 * limit after base64/JSON overhead and for inbound MIME webhooks. Only the
 * declared Content-Length is checked; providers and HTTP clients send it
 * for these routes.
 */
const DEFAULT_LIMIT_MB = 50;

function limitBytes() {
	const configured = Number(process.env.MAX_REQUEST_BODY_MB);
	const mb =
		Number.isFinite(configured) && configured > 0
			? configured
			: DEFAULT_LIMIT_MB;
	return Math.floor(mb * 1024 * 1024);
}

export default defineEventHandler((event) => {
	const path = event.path || "";
	if (!path.startsWith("/api/")) return;

	const method = event.method;
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

	const declared = getRequestHeader(event, "content-length");
	if (!declared) return;

	const length = Number(declared);
	if (!Number.isFinite(length) || length < 0) {
		throw createError({ statusCode: 400, statusMessage: "Invalid Content-Length" });
	}
	if (length > limitBytes()) {
		throw createError({
			statusCode: 413,
			statusMessage: "Request body too large",
		});
	}
});
