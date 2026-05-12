import { defineEventHandler, readBody } from "h3";
import {
	assertInboundWebhookAuthorized,
	storeInboundRawEmail,
} from "../../../../../utils/inbound-email";

export default defineEventHandler(async (event) => {
	assertInboundWebhookAuthorized(event);

	try {
		const body = await readBody(event);
		const raw = body?.RawEmail;
		const rawMime = Buffer.isBuffer(raw)
			? raw.toString("utf8")
			: String(raw || "");
		return await storeInboundRawEmail(rawMime);
	} catch (err) {
		console.error("[Webhook] Postmark inbound error:", err);
		throw err;
	}
});
