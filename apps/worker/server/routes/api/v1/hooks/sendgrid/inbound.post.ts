import { defineEventHandler, readMultipartFormData } from "h3";
import {
	assertInboundWebhookAuthorized,
	getToEmails,
	storeInboundRawEmail,
} from "../../../../../utils/inbound-email";

export { getToEmails };

export default defineEventHandler(async (event) => {
	assertInboundWebhookAuthorized(event);

	try {
		const parts = await readMultipartFormData(event);
		if (!parts) return { ok: false, error: "No multipart body" };

		const emailPart = parts.find((p) => p.name === "email");
		if (!emailPart) {
			return { ok: false, error: "No email field in inbound payload" };
		}

		const rawMime = Buffer.from(emailPart.data).toString("utf8");
		return await storeInboundRawEmail(rawMime);
	} catch (err) {
		console.error("[Webhook] SendGrid inbound error:", err);
		throw err;
	}
});
