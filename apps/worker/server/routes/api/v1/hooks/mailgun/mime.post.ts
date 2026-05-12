import { defineEventHandler, readBody } from "h3";
import {
	assertInboundWebhookAuthorized,
	storeInboundRawEmail,
} from "../../../../../utils/inbound-email";

export default defineEventHandler(async (event) => {
	assertInboundWebhookAuthorized(event);

	try {
		const body = await readBody(event);
		const rawMime = body?.["body-mime"];
		return await storeInboundRawEmail(String(rawMime || ""));
	} catch (err) {
		console.error("[Webhook] Mailgun inbound error:", err);
		throw err;
	}
});
