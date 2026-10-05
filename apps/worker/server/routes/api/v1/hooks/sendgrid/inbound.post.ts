import { defineEventHandler, readMultipartFormData } from "h3";
import {
	assertInboundWebhookAuthorized,
	extractEmailAddresses,
	getToEmails,
	storeInboundRawEmail,
} from "../../../../../utils/inbound-email";

export { getToEmails };

function getEnvelopeRecipients(envelope: string | undefined): string[] {
	if (!envelope) return [];
	try {
		return extractEmailAddresses(JSON.parse(envelope)?.to);
	} catch {
		return [];
	}
}

export default defineEventHandler(async (event) => {
	assertInboundWebhookAuthorized(event);

	try {
		const parts = await readMultipartFormData(event);
		if (!parts) return { ok: false, error: "No multipart body" };

		const emailPart = parts.find((p) => p.name === "email");
		if (!emailPart) {
			return { ok: false, error: "No email field in inbound payload" };
		}

		const envelopePart = parts.find((p) => p.name === "envelope");
		const envelopeRecipients = getEnvelopeRecipients(
			envelopePart
				? Buffer.from(envelopePart.data).toString("utf8")
				: undefined,
		);

		const rawMime = Buffer.from(emailPart.data).toString("utf8");
		return await storeInboundRawEmail(rawMime, envelopeRecipients);
	} catch (err) {
		console.error("[Webhook] SendGrid inbound error:", err);
		throw err;
	}
});
