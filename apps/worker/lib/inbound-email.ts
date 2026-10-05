import { timingSafeEqual } from "node:crypto";
import { db, identities, mailboxes, providers } from "@db";
import { getServerEnv, type Providers } from "@schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createError, getHeader, getQuery, type H3Event } from "h3";
import { type ParsedMail, simpleParser } from "mailparser";
import { v4 as uuidv4 } from "uuid";
import { parseAndStoreEmail } from "./message-payload-parser";

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

/**
 * Rejects inbound provider webhooks (Mailgun, Postmark, SendGrid) that do not
 * present INBOUND_WEBHOOK_SECRET. Fails closed in production when the secret
 * is not configured.
 */
export function assertInboundWebhookAuthorized(event: H3Event) {
	const { INBOUND_WEBHOOK_SECRET: secret, NODE_ENV } = getServerEnv();

	if (!secret) {
		if (NODE_ENV === "production") {
			console.error(
				"[InboundWebhook] INBOUND_WEBHOOK_SECRET is not configured; rejecting request",
			);
			throw createError({
				statusCode: 503,
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
	const dmarcFail = /dmarc=\s*fail/i.test(authRes);
	const spamStatus = String(headers.get("x-spam-status") ?? "");
	const mailgunFlag = String(
		headers.get("x-mailgun-sflag") ?? "",
	).toLowerCase();

	return mailgunFlag === "yes" || /^yes\b/i.test(spamStatus) || dmarcFail;
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
 * Collects the recipient candidates of an inbound message: the SMTP envelope
 * recipients reported by the provider first (they include Bcc), then To and
 * Cc. Lower-cased and deduplicated.
 */
export function collectRecipientCandidates(
	parsed: ParsedMail,
	envelopeRecipients: string[] = [],
) {
	return [
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
}

/**
 * Finds the identity of the first recipient candidate (case-insensitive),
 * optionally restricted to one workspace and/or to identities wired to a
 * provider of the given type (directly or through their domain identity).
 *
 * Identity values are only unique per workspace, so the same address can
 * exist in several workspaces. Unverified duplicates must not be able to
 * capture another tenant's mail: when an address matches identities in more
 * than one workspace, only a verified one (identity or its domain) is used,
 * and the message is rejected if that is still ambiguous.
 */
export async function findIdentityForRecipients(
	candidates: string[],
	workspaceId?: string,
	providerType?: Providers,
) {
	if (!candidates.length) return null;

	const rows = await db
		.select({ identity: identities, providerType: providers.type })
		.from(identities)
		.leftJoin(providers, eq(identities.providerId, providers.id))
		.where(
			and(
				inArray(sql`lower(${identities.value})`, candidates),
				workspaceId ? eq(identities.workspaceId, workspaceId) : undefined,
			),
		);

	// Domain identities of the matches: their provider and verification.
	const domainIds = [
		...new Set(
			rows
				.map((r) => r.identity.domainIdentityId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	const domains = domainIds.length
		? await db
				.select({
					id: identities.id,
					status: identities.status,
					providerType: providers.type,
				})
				.from(identities)
				.leftJoin(providers, eq(identities.providerId, providers.id))
				.where(inArray(identities.id, domainIds))
		: [];
	const domainById = new Map(domains.map((d) => [d.id, d]));
	const withDomain = rows.map((r) => {
		const domain = r.identity.domainIdentityId
			? domainById.get(r.identity.domainIdentityId)
			: undefined;
		return {
			...r,
			domainProviderType: domain?.providerType ?? null,
			domainStatus: domain?.status ?? null,
		};
	});

	const matches = providerType
		? withDomain.filter(
				(r) =>
					r.providerType === providerType ||
					r.domainProviderType === providerType,
			)
		: withDomain;

	for (const addr of candidates) {
		const forAddr = matches.filter(
			(m) => m.identity.value.toLowerCase() === addr,
		);
		if (!forAddr.length) continue;

		const workspacesForAddr = new Set(
			forAddr.map((m) => m.identity.workspaceId),
		);
		if (workspacesForAddr.size === 1) return forAddr[0].identity;

		const verified = forAddr.filter(
			(m) =>
				m.identity.status === "verified" || m.domainStatus === "verified",
		);
		const verifiedWorkspaces = new Set(
			verified.map((m) => m.identity.workspaceId),
		);
		if (verifiedWorkspaces.size === 1) return verified[0].identity;

		console.warn(
			"[InboundWebhook] Recipient matches identities in several workspaces; not delivering",
			{ recipient: addr, workspaces: workspacesForAddr.size },
		);
		return null;
	}

	return null;
}

/**
 * Stores a raw inbound MIME message for the first recipient that matches an
 * identity. Permanent rejects (no recipient / identity / inbox) resolve with
 * `{ ok: false, reason }` so the HTTP layer answers 2xx and providers do not
 * keep retrying a message that can never be delivered.
 *
 * @param envelopeRecipients SMTP envelope recipients reported by the provider;
 *   preferred over the To/Cc headers when present.
 * @param providerType provider whose webhook delivered the message; only
 *   identities of that provider type are considered.
 */
export async function storeInboundRawEmail(
	rawMime: string,
	envelopeRecipients: string[] = [],
	providerType?: Providers,
): Promise<InboundStoreResult> {
	if (!rawMime || typeof rawMime !== "string") {
		console.warn("[InboundWebhook] Rejecting payload without raw email");
		return { ok: false, reason: "Missing raw email payload" };
	}

	// keepCidLinks: the parse is reused by parseAndStoreEmail (no second parse).
	const parsed = await simpleParser(rawMime, { keepCidLinks: true });
	const candidates = collectRecipientCandidates(parsed, envelopeRecipients);

	if (!candidates.length) {
		console.warn("[InboundWebhook] Rejecting email without recipients");
		return { ok: false, reason: "Inbound email has no recipient" };
	}

	// Only identities wired to the provider whose webhook delivered the mail:
	// a Mailgun webhook cannot drop mail into an SMTP/Gmail/other-provider
	// identity that merely shares the address.
	const identity = await findIdentityForRecipients(
		candidates,
		undefined,
		providerType,
	);

	if (!identity) {
		console.warn("[InboundWebhook] No identity found for recipients", {
			candidates,
		});
		return { ok: false, reason: "No identity found for recipient" };
	}

	const userMailboxes = await db
		.select()
		.from(mailboxes)
		.where(
			and(
				eq(mailboxes.identityId, identity.id),
				eq(mailboxes.workspaceId, identity.workspaceId),
			),
		);

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
		workspaceId: identity.workspaceId,
		mailboxId: targetMailbox.id,
		rawStorageKey,
		emlKey,
		parsed,
	});

	return {
		ok: true,
		identityId: identity.id,
		mailboxId: targetMailbox.id,
		messageId: message?.id ?? null,
	};
}
