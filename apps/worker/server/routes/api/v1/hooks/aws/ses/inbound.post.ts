import { defineEventHandler, readRawBody } from "h3";
import {
	db,
	decryptAdminSecrets,
	mailboxes,
	providers,
	providerSecrets,
} from "@db";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { getPublicEnv, getServerEnv } from "@schema";
import { createClient } from "@supabase/supabase-js";

import {
	isTrustedSnsUrl,
	verifySnsMessage,
} from "../../../../../../../lib/aws-sns";
import { parseAndStoreEmail } from "../../../../../../../lib/message-payload-parser";

const publicConfig = getPublicEnv();
const serverConfig = getServerEnv();
const supabase = createClient(
	publicConfig.API_URL,
	serverConfig.SERVICE_ROLE_KEY,
);

export default defineEventHandler(async (event) => {
	try {
		const raw = (await readRawBody(event)) || "";
		const sns = JSON.parse(raw as string);

		// Reject anything that is not a genuine, signed SNS delivery.
		if (!(await verifySnsMessage(sns))) {
			console.warn("[Webhook] Rejected SNS payload with invalid signature");
			return { ok: false };
		}

		// 1) One-time SNS handshake
		if (sns?.Type === "SubscriptionConfirmation" && sns.SubscribeURL) {
			// Only ever call back to AWS SNS (prevents SSRF via SubscribeURL).
			if (!isTrustedSnsUrl(sns.SubscribeURL)) {
				console.warn("[Webhook] Refusing untrusted SNS SubscribeURL");
				return { ok: false };
			}
			await $fetch(sns.SubscribeURL as string, { method: "GET" });
			console.log("[Webhook] SNS subscription confirmed");
			return { ok: true };
		}

		// 2) Normal notifications (S3 → SNS). We expect Message to be the S3 event JSON
		if (sns?.Type === "Notification" && sns?.Message) {
			const msg =
				typeof sns.Message === "string" ? JSON.parse(sns.Message) : sns.Message;
			const rec = msg?.Records?.[0];
			if (!rec || rec.eventSource !== "aws:s3") {
				console.log("[Webhook] Non-S3 notification, ignoring.");
				return { ok: true };
			}

			const bucket: string = rec.s3?.bucket?.name;
			const key: string = decodeURIComponent(rec.s3?.object?.key || "");
			const size: number = rec.s3?.object?.size ?? 0;

			console.log("[S3] ObjectCreated:", { bucket, key, size });

			const [, ownerId, providerId, identityId, emlId] = key.split("/");
			if (!ownerId || !providerId || !identityId || !emlId) {
				console.warn("[Webhook] Unexpected S3 key layout, ignoring.", { key });
				return { ok: true };
			}

			const [provider] = await db
				.select()
				.from(providers)
				.where(eq(providers.id, providerId));

			if (
				!provider ||
				provider.ownerId !== ownerId ||
				provider.type !== "ses"
			) {
				console.warn("[Webhook] No matching SES provider for S3 key", { key });
				return { ok: true };
			}

			// The notification must come from the bucket/topic bootstrapped for this
			// provider; otherwise anyone could point us at arbitrary objects.
			const resourceIds = provider.metaData?.verification?.resourceIds as
				| { bucket?: string; topicArn?: string }
				| undefined;
			if (resourceIds?.bucket && resourceIds.bucket !== bucket) {
				console.warn("[Webhook] S3 bucket does not match provider", {
					bucket,
					providerId,
				});
				return { ok: true };
			}
			if (resourceIds?.topicArn && resourceIds.topicArn !== sns.TopicArn) {
				console.warn("[Webhook] SNS topic does not match provider", {
					topicArn: sns.TopicArn,
					providerId,
				});
				return { ok: true };
			}

			const [secrets] = await decryptAdminSecrets({
				linkTable: providerSecrets,
				foreignCol: providerSecrets.providerId,
				secretIdCol: providerSecrets.secretId,
				ownerId,
				parentId: providerId,
			});

			const vaultValues = secrets?.vault?.decrypted_secret
				? JSON.parse(secrets.vault.decrypted_secret)
				: {};

			const s3 = new S3Client({
				region: vaultValues.SES_REGION,
				credentials: {
					accessKeyId: vaultValues.SES_ACCESS_KEY_ID,
					secretAccessKey: vaultValues.SES_SECRET_ACCESS_KEY,
				},
			});

			const getObj = await s3.send(
				new GetObjectCommand({ Bucket: bucket, Key: key }),
			);
			const rawEmail = (await getObj?.Body?.transformToString("utf-8")) || "";

			// The raw EML is stored by parseAndStoreEmail (under `key`); it used
			// to be uploaded a second time here to a path nothing references.
			// Parse once with the options parseAndStoreEmail needs and hand the
			// result over instead of parsing the message twice.
			const parsed = await simpleParser(rawEmail, { keepCidLinks: true });
			const headers = parsed.headers as Map<string, any>;

			const userMailboxes = await db
				.select()
				.from(mailboxes)
				.where(
					and(
						eq(mailboxes.identityId, identityId),
						eq(mailboxes.ownerId, ownerId),
					),
				);

			const inbox = userMailboxes.find((m) => m.kind === "inbox");
			const spamMb = userMailboxes.find((m) => m.kind === "spam");
			// const junkMb = userMailboxes.find(m => m.kind === "junk");

			if (!inbox)
				throw new Error("No inbox mailbox found for identity " + identityId);
			if (!spamMb)
				throw new Error("No spam mailbox found for identity " + identityId);
			if (!provider) throw new Error("No provider found for id " + providerId);

			let providerSaysSpam = false;
			if (provider?.type === "ses") {
				const spamVerdict = String(headers.get("x-ses-spam-verdict") ?? "")
					.trim()
					.toUpperCase();
				const virusVerdict = String(headers.get("x-ses-virus-verdict") ?? "")
					.trim()
					.toUpperCase();
				// mark as spam if either is not PASS
				providerSaysSpam =
					(spamVerdict !== "" && spamVerdict !== "PASS") ||
					(virusVerdict !== "" && virusVerdict !== "PASS");
			}

			const authRes = String(headers.get("authentication-results") ?? "");
			const spfFail = /spf=\s*fail/i.test(authRes);
			const dkimFail = /dkim=\s*fail/i.test(authRes);
			const dmarcFail = /dmarc=\s*fail/i.test(authRes);
			const authSaysJunk = (spfFail && dkimFail && dmarcFail) || dmarcFail;

			console.log("providerSaysSpam", providerSaysSpam);
			console.log("authSaysJunk", authSaysJunk);

			let targetMailboxId = inbox.id;
			if (providerSaysSpam && spamMb) {
				targetMailboxId = spamMb.id;
			}

			await parseAndStoreEmail(rawEmail, {
				ownerId,
				mailboxId: targetMailboxId,
				rawStorageKey: key, // S3 key
				emlKey: emlId,
				parsed,
			});

			const channel = await supabase.channel(`${ownerId}-mailbox`);

			channel.subscribe((status) => {
				if (status !== "SUBSCRIBED") {
					return null;
				}
				channel.send({
					type: "broadcast",
					event: "mail-received",
					payload: { reload: true },
				});
				channel.unsubscribe();
				return;
			});

			// Optional: fetch the raw RFC822 now (you can move this to a worker if preferred)
			// const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
			// const rawEmail = await obj.Body?.transformToString(); // Node 18+ SDK helper
			// TODO: enqueue or parse with `mailparser` here

			// TODO: insert a lightweight row to your DB linking to {bucket, key}
			// (so the UI can list messages immediately while a worker parses content)

			return { ok: true };
		}

		// 3) Anything else
		console.log("[Webhook] Ignored payload shape.");
		return { ok: true };
	} catch (err) {
		console.error("[Webhook] Error:", err);
		return { ok: true };
	}
});
