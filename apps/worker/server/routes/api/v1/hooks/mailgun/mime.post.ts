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
} from "../../../../../utils/inbound-email";

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
		return await storeInboundRawEmail(
			String(rawMime || ""),
			extractEmailAddresses(fields.recipient),
		);
	} catch (err) {
		console.error("[Webhook] Mailgun inbound error:", err);
		throw err;
	}
});
