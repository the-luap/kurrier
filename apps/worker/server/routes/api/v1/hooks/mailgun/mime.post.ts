import {
	defineEventHandler,
	getHeader,
	type H3Event,
	readBody,
	readMultipartFormData,
} from "h3";
import {
	assertInboundWebhookAuthorized,
	extractEmailAddresses,
	storeInboundRawEmail,
} from "../../../../../../lib/inbound-email";

/**
 * Mailgun "forward" routes post multipart/form-data (readBody does not parse
 * it, so `body-mime` used to be undefined); other setups post urlencoded.
 */
async function readMailgunFields(
	event: H3Event,
): Promise<Record<string, unknown>> {
	const contentType = (getHeader(event, "content-type") ?? "").toLowerCase();

	if (contentType.startsWith("multipart/form-data")) {
		const parts = (await readMultipartFormData(event)) ?? [];
		const fields: Record<string, string> = {};
		for (const part of parts) {
			if (!part.name || part.name in fields) continue;
			fields[part.name] = Buffer.from(part.data).toString("utf8");
		}
		return fields;
	}

	const body = await readBody(event);
	return (body ?? {}) as Record<string, unknown>;
}

export default defineEventHandler(async (event) => {
	assertInboundWebhookAuthorized(event);

	try {
		const fields = await readMailgunFields(event);
		const rawMime = fields["body-mime"];
		// Permanent rejects resolve with { ok: false } and HTTP 200, so
		// Mailgun does not retry them; unexpected errors return 5xx and are
		// retried.
		return await storeInboundRawEmail(
			String(rawMime || ""),
			extractEmailAddresses(fields.recipient),
			"mailgun",
		);
	} catch (err) {
		console.error("[Webhook] Mailgun inbound error", err);
		throw err;
	}
});
