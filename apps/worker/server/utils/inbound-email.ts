import { timingSafeEqual } from "node:crypto";
import { db, identities, mailboxes } from "@db";
import { eq, inArray, sql } from "drizzle-orm";
import { createError, getHeader, getQuery, type H3Event } from "h3";
import { type ParsedMail, simpleParser } from "mailparser";
import { v4 as uuidv4 } from "uuid";
import { parseAndStoreEmail } from "../../lib/message-payload-parser";

function safeEqual(a: string, b: string) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Collects every credential the caller may have presented. Mailgun, Postmark
 * and SendGrid cannot send custom headers, so besides the header options we
 * also accept HTTP Basic auth (username or password = secret, e.g.
 * https://user:SECRET@host/...) and a `token` query parameter.
 */
function getPresentedSecrets(event: H3Event): string[] {
	const candidates: string[] = [];
	const auth = (getHeader(event, "authorization") ?? "").trim();
	const lowerAuth = auth.toLowerCase();

	if (lowerAuth.startsWith("bearer ")) {
		candidates.push(auth.slice(7).trim());
	} else if (lowerAuth.startsWith("basic ")) {
		try {
			const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString(
				"utf8",
			);
			const sep = decoded.indexOf(":");
			if (sep >= 0) {
				candidates.push(decoded.slice(0, sep), decoded.slice(sep + 1));
			} else {
				candidates.push(decoded);
			}
		} catch {
			// ignore malformed basic auth
		}
	}

	const headerSecret =
		getHeader(event, "x-kurrier-webhook-secret") ||
		getHeader(event, "x-webhook-secret");
	if (headerSecret) candidates.push(headerSecret);

	const token = getQuery(event)?.token;
	const tokenValue = Array.isArray(token) ? token[0] : token;
	if (typeof tokenValue === "string") candidates.push(tokenValue);

	return candidates.filter((c) => c.length > 0);
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

	// Evaluate every candidate (no short-circuit) to keep timing uniform.
	let authorized = false;
	for (const candidate of getPresentedSecrets(event)) {
		if (safeEqual(candidate, secret)) authorized = true;
	}

	if (!authorized) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid inbound webhook secret",
		});
	}
}

function addressesOf(field: ParsedMail["to"]): string[] {
	if (!field) return [];
	const list = Array.isArray(field) ? field : [field];
	return list.flatMap(
		(addrObj) =>
			addrObj.value.map((email) => email.address).filter(Boolean) as string[],
	);
}

export function getToEmails(parsed: ParsedMail): string[] {
	return addressesOf(parsed.to);
}

/**
 * Extracts plain email addresses from loosely formatted recipient values
 * (e.g. `"Name" <a@b.c>, d@e.f` or arrays of those).
 */
export function extractEmailAddresses(value: unknown): string[] {
	if (value == null) return [];
	if (Array.isArray(value)) return value.flatMap(extractEmailAddresses);
	const matches = String(value).match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g);
	return matches ?? [];
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

export type InboundStoreResult =
	| {
			ok: true;
			identityId: string;
			mailboxId: string;
			messageId: string | null;
	  }
	| { ok: false; reason: string };

/**
 * Stores a raw inbound MIME message for the first recipient that matches an
 * identity. Permanent rejects (no recipient / identity / inbox) resolve with
 * `{ ok: false, reason }` so the HTTP layer answers 2xx and providers do not
 * keep retrying a message that can never be delivered.
 *
 * @param envelopeRecipients SMTP envelope recipients reported by the provider;
 *   preferred over the To/Cc headers when present.
 */
export async function storeInboundRawEmail(
	rawMime: string,
	envelopeRecipients: string[] = [],
): Promise<InboundStoreResult> {
	if (!rawMime || typeof rawMime !== "string") {
		throw createError({
			statusCode: 400,
			statusMessage: "Missing raw email payload",
		});
	}

	const parsed = await simpleParser(rawMime);
	const candidates = [
		...new Set(
			[
				...envelopeRecipients,
				...addressesOf(parsed.to),
				...addressesOf(parsed.cc),
			]
				.map((a) => a.trim().toLowerCase())
				.filter(Boolean),
		),
	];

	if (!candidates.length) {
		console.warn("[InboundWebhook] Rejecting email without recipients");
		return { ok: false, reason: "Inbound email has no recipient" };
	}

	const matches = await db
		.select()
		.from(identities)
		.where(inArray(sql`lower(${identities.value})`, candidates));

	const identity = candidates
		.map((addr) => matches.find((m) => m.value.toLowerCase() === addr))
		.find(Boolean);

	if (!identity) {
		console.warn("[InboundWebhook] No identity found for recipients", {
			candidates,
		});
		return { ok: false, reason: "No identity found for recipient" };
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
		console.warn("[InboundWebhook] Recipient identity has no inbox mailbox", {
			identityId: identity.id,
		});
		return { ok: false, reason: "Recipient identity has no inbox mailbox" };
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
