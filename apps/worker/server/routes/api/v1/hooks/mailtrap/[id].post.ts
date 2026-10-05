import crypto from "node:crypto";
import {
	db,
	decryptAdminSecrets,
	mailboxes,
	providerSecrets,
	providers,
} from "@db";
import { and, eq } from "drizzle-orm";
import { defineEventHandler, getHeader, getRouterParam, readRawBody } from "h3";
import { safeHttpRequest } from "@providers/net-guard";
import { simpleParser } from "mailparser";
import { v4 as uuidv4 } from "uuid";
import { UUID_RE } from "../../../../../../lib/api-helpers";
import { parseAndStoreEmail } from "../../../../../../lib/message-payload-parser";
import {
	collectRecipientCandidates,
	findIdentityForRecipients,
} from "../../../../../../lib/inbound-email";

function safeEqual(a: string, b: string) {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);

	if (ab.length !== bb.length) return false;

	return crypto.timingSafeEqual(ab, bb);
}

function isSignatureValid(
	signatureHeader: string | undefined,
	secret: string | undefined,
	rawBody: string,
): boolean {
	if (!secret || !signatureHeader) return false;

	const expected = crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex");
	return safeEqual(signatureHeader, expected);
}

type MessageRef = { messageId: string; inboxId: string };

// Payload shape: { events: [{ event, message_id, inbox_id, ... }] }.
// Mailtrap can batch several events into one webhook call 
// so process them all, but dedupe by message_id to avoid redundant API calls.
function extractMessageRefs(body: any): MessageRef[] {
	const events = Array.isArray(body?.events) ? body.events : [body];

	const refs = events
		.map((evt: any) => {
			const messageId = evt?.message_id;
			const inboxId = evt?.inbox_id ?? evt?.inbound_inbox_id;

			if (!messageId || !inboxId) return null;

			return { messageId: String(messageId), inboxId: String(inboxId) };
		})
		.filter((ref: MessageRef | null): ref is MessageRef => ref !== null);

	// Avoid redundant Mailtrap API calls if the same message_id
	// appears twice in one payload.
	const seen = new Set<string>();
	return refs.filter((ref: MessageRef) => {
		if (seen.has(ref.messageId)) return false;
		seen.add(ref.messageId);
		return true;
	});
}

export default defineEventHandler(async (event) => {
	try {
		const providerId = getRouterParam(event, "id");

		if (!providerId || !UUID_RE.test(providerId)) {
			event.node.res.statusCode = 404;
			return { ok: false, error: "Missing provider id" };
		}

		const [provider] = await db
			.select()
			.from(providers)
			.where(and(eq(providers.id, providerId), eq(providers.type, "mailtrap")));

		if (!provider) {
			event.node.res.statusCode = 404;
			return { ok: false, error: "Mailtrap provider not found" };
		}

		const [providerSecret] = await decryptAdminSecrets({
			linkTable: providerSecrets,
			foreignCol: providerSecrets.providerId,
			secretIdCol: providerSecrets.secretId,
			ownerId: provider.ownerId,
			parentId: providerId,
		});

		const credentials = providerSecret?.vault?.decrypted_secret
			? JSON.parse(providerSecret.vault.decrypted_secret)
			: {};

		const apiToken: string | undefined = credentials.MAILTRAP_API_TOKEN;
		const webhookSecret: string | undefined =
			credentials.MAILTRAP_WEBHOOK_SECRET;

		const rawBody = (await readRawBody(event)) || "";

		if (
			!isSignatureValid(
				getHeader(event, "mailtrap-signature"),
				webhookSecret,
				rawBody,
			)
		) {
			event.node.res.statusCode = 401;
			return { ok: false, error: "Unauthorized" };
		}

		if (!apiToken) {
			console.error(
				"[Webhook] Mailtrap error: provider has no MAILTRAP_API_TOKEN configured",
			);
			event.node.res.statusCode = 500;
			return { ok: false, error: "MAILTRAP_API_TOKEN not configured" };
		}

		const body = JSON.parse(rawBody);
		const refs = extractMessageRefs(body);

		if (!refs.length) {
			console.log(
				"[Webhook] Mailtrap: no message_id/inbox_id in payload, ignoring.",
			);
			return { ok: true };
		}

		// Failure detail (e.g. "No identity found for toAddress <email>") stays
		// in the log only
		const failures: string[] = [];

		for (const ref of refs) {
			try {
				await processMailtrapMessage(ref, apiToken, provider.workspaceId);
			} catch (err: any) {
				console.error(
					`[Webhook] Mailtrap: failed to process message ${ref.messageId}:`,
					err,
				);
				failures.push(ref.messageId);
			}
		}

		if (failures.length) {
			event.node.res.statusCode = 500;
			return {
				ok: false,
				error: "Some messages failed to process",
				failed: failures,
			};
		}

		return { ok: true };
	} catch (err) {
		console.error("[Webhook] Mailtrap inbound error:", err);
		event.node.res.statusCode = 500;
		return { ok: false, error: "Internal error" };
	}
});

async function processMailtrapMessage(
	ref: MessageRef,
	apiToken: string,
	workspaceId: string,
): Promise<void> {
	const messageMeta: any = await $fetch(
		`https://mailtrap.io/api/inbound/inboxes/${encodeURIComponent(ref.inboxId)}/messages/${encodeURIComponent(ref.messageId)}`,
		{ headers: { "Api-Token": apiToken } },
	);

	const rawMessageUrl = messageMeta?.raw_message_url;
	if (!rawMessageUrl) {
		throw new Error("No raw_message_url in message metadata");
	}

	// The API token is only sent to Mailtrap itself; any other host (e.g. a
	// storage link) is fetched without it and through the SSRF guard.
	let rawUrl: URL;
	try {
		rawUrl = new URL(String(rawMessageUrl));
	} catch {
		throw new Error("Invalid raw_message_url in message metadata");
	}
	const isMailtrapHost =
		rawUrl.protocol === "https:" &&
		(rawUrl.hostname === "mailtrap.io" ||
			rawUrl.hostname.endsWith(".mailtrap.io"));

	let rawMime = "";
	let downloadUrl: string | null = rawUrl.toString();
	if (isMailtrapHost) {
		// Redirects are not followed with the token attached: a redirect to
		// e.g. object storage is fetched below without it.
		const res = await fetch(downloadUrl, {
			headers: { "Api-Token": apiToken },
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			downloadUrl = location ? new URL(location, downloadUrl).toString() : null;
			if (!downloadUrl) throw new Error("Raw message redirect without location");
		} else if (!res.ok) {
			throw new Error(`Raw message download failed: HTTP ${res.status}`);
		} else {
			rawMime = await res.text();
			downloadUrl = null;
		}
	}
	if (downloadUrl) {
		const res = await safeHttpRequest(downloadUrl, {
			timeoutMs: 30_000,
			maxResponseBytes: 50 * 1024 * 1024,
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Raw message download failed: HTTP ${res.status}`);
		}
		rawMime = res.body.toString("utf8");
	}

	// Parsed once (keepCidLinks, as parseAndStoreEmail expects) and reused.
	const parsed = await simpleParser(rawMime, { keepCidLinks: true });

	// To and Cc, case-insensitive (only the first To matched before).
	const candidates = collectRecipientCandidates(parsed);
	if (!candidates.length) {
		throw new Error("No recipient address in parsed message");
	}

	const identity = await findIdentityForRecipients(candidates, workspaceId);

	if (!identity) {
		throw new Error(
			`No identity found for recipients ${candidates.join(", ")}`,
		);
	}
	const toAddress = identity.value;

	const emlId = uuidv4();
	const rawStorageKey = `eml/${identity.ownerId}/${emlId}`;

	const headers = parsed.headers as Map<string, any>;

	const userMailboxes = await db
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.identityId, identity.id));

	const inbox = userMailboxes.find((m) => m.kind === "inbox");
	const spamMb = userMailboxes.find((m) => m.kind === "spam");

	const authRes = String(headers.get("authentication-results") ?? "");
	const spfFail = /spf=\s*fail/i.test(authRes);
	const dkimFail = /dkim=\s*fail/i.test(authRes);
	const dmarcFail = /dmarc=\s*fail/i.test(authRes);

	// dmarcFail alone already implies the (spfFail && dkimFail && dmarcFail)
	// clause, so junk on DMARC failure, or on SPF+DKIM failing together
	// without a DMARC verdict.
	const authSaysJunk: boolean = dmarcFail || (spfFail && dkimFail);

	const targetMailbox = authSaysJunk ? spamMb : inbox;
	if (!targetMailbox) {
		// String(undefined) would otherwise silently become the literal
		// mailboxId "undefined" — throw instead so this shows up as a
		// per-message failure the batch loop can report/retry.
		throw new Error(
			`No ${authSaysJunk ? "spam" : "inbox"} mailbox for identity ${identity.id}`,
		);
	}

	await parseAndStoreEmail(rawMime, {
		ownerId: identity.ownerId,
		workspaceId: identity.workspaceId,
		mailboxId: targetMailbox.id,
		rawStorageKey,
		emlKey: emlId,
		parsed,
	});

	console.log(
		`[Webhook] Mailtrap: stored message ${ref.messageId} for ${toAddress} (identity ${identity.id})`,
	);
}
