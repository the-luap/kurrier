import { timingSafeEqual } from "node:crypto";
import { db, identities, mailboxes } from "@db";
import { eq } from "drizzle-orm";
import { createError, getHeader, type H3Event } from "h3";
import { type ParsedMail, simpleParser } from "mailparser";
import { v4 as uuidv4 } from "uuid";
import { parseAndStoreEmail } from "./message-payload-parser";

function safeEqual(a: string, b: string) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function assertInboundWebhookAuthorized(event: H3Event) {
	const secret =
		process.env.INBOUND_WEBHOOK_SECRET ||
		process.env.KURRIER_INBOUND_WEBHOOK_SECRET;

	if (!secret) {
		if (process.env.NODE_ENV === "production") {
			throw createError({
				statusCode: 500,
				statusMessage: "Inbound webhook secret is not configured",
			});
		}
		console.warn(
			"[InboundWebhook] INBOUND_WEBHOOK_SECRET missing; allowing request in non-production mode",
		);
		return;
	}

	const auth = getHeader(event, "authorization") ?? "";
	const bearer = auth.toLowerCase().startsWith("bearer ")
		? auth.slice(7).trim()
		: "";
	const headerSecret =
		getHeader(event, "x-kurrier-webhook-secret") ||
		getHeader(event, "x-webhook-secret") ||
		bearer;

	if (!headerSecret || !safeEqual(headerSecret, secret)) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid inbound webhook secret",
		});
	}
}

export function getToEmails(parsed: ParsedMail): string[] {
	if (!parsed.to) return [];
	const tos = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
	return tos.flatMap(
		(addrObj) =>
			addrObj.value.map((email) => email.address).filter(Boolean) as string[],
	);
}

function isAuthenticationFailure(headers: Map<string, unknown>) {
	const authRes = String(headers.get("authentication-results") ?? "");
	const spfFail = /spf=\s*fail/i.test(authRes);
	const dkimFail = /dkim=\s*fail/i.test(authRes);
	const dmarcFail = /dmarc=\s*fail/i.test(authRes);
	const spamStatus = String(headers.get("x-spam-status") ?? "");
	const mailgunFlag = String(
		headers.get("x-mailgun-sflag") ?? "",
	).toLowerCase();

	return (
		mailgunFlag === "yes" ||
		/^yes\b/i.test(spamStatus) ||
		dmarcFail ||
		(spfFail && dkimFail && dmarcFail)
	);
}

export async function storeInboundRawEmail(rawMime: string) {
	if (!rawMime || typeof rawMime !== "string") {
		throw createError({
			statusCode: 400,
			statusMessage: "Missing raw email payload",
		});
	}

	const parsed = await simpleParser(rawMime);
	const toAddress = getToEmails(parsed)[0]?.toLowerCase() ?? null;
	if (!toAddress) {
		throw createError({
			statusCode: 400,
			statusMessage: "Inbound email has no recipient",
		});
	}

	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.value, toAddress))
		.limit(1);

	if (!identity) {
		throw createError({
			statusCode: 404,
			statusMessage: "No identity found for recipient",
		});
	}

	const userMailboxes = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.identityId, identity.id));

	const inbox = userMailboxes.find((m) => m.kind === "inbox");
	const spam = userMailboxes.find((m) => m.kind === "spam");
	const targetMailbox = isAuthenticationFailure(
		parsed.headers as Map<string, unknown>,
	)
		? spam || inbox
		: inbox;

	if (!targetMailbox) {
		throw createError({
			statusCode: 409,
			statusMessage: "Recipient identity has no inbox mailbox",
		});
	}

	const emlKey = uuidv4();
	const rawStorageKey = `eml/${identity.ownerId}/${emlKey}`;
	const message = await parseAndStoreEmail(rawMime, {
		ownerId: identity.ownerId,
		mailboxId: targetMailbox.id,
		rawStorageKey,
		emlKey,
	});

	return {
		ok: true,
		identityId: identity.id,
		mailboxId: targetMailbox.id,
		messageId: message?.id ?? null,
	};
}
