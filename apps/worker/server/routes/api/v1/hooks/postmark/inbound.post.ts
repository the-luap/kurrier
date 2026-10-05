import { defineEventHandler, readBody } from "h3";
import {
	assertInboundWebhookAuthorized,
	extractEmailAddresses,
	storeInboundRawEmail,
} from "../../../../../../lib/inbound-email";

export default defineEventHandler(async (event) => {
	assertInboundWebhookAuthorized(event);

	try {
		const body = await readBody(event);
		const raw = body?.RawEmail;
		const rawMime = Buffer.isBuffer(raw)
			? raw.toString("utf8")
			: String(raw || "");
		// Permanent rejects resolve with { ok: false } and HTTP 200, so
		// Postmark does not retry them; unexpected errors return 5xx.
		return await storeInboundRawEmail(
			rawMime,
			extractEmailAddresses(body?.OriginalRecipient),
			"postmark",
		);
	} catch (err) {
		console.error("[Webhook] Postmark inbound error:", err);
		throw err;
	}
});
