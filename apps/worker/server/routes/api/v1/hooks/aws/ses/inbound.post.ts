import { defineEventHandler, readRawBody } from "h3";
import {
	db,
	decryptAdminSecrets,
	identities,
	mailboxes,
	providers,
	providerSecrets,
} from "@db";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { parseAndStoreEmail } from "../../../../../../../lib/message-payload-parser";
import {MessageValidator} from "aws-sns-validator";
const snsValidator = new MessageValidator();
async function verifySnsMessage(message: unknown): Promise<void> {
	await snsValidator.validate(message as Record<string, unknown>);
}
function isSafeSnsSubscribeUrl(value: unknown): value is string {

	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") {
			return false;
		}
		return (
			/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) ||
			/^sns\.[a-z0-9-]+\.amazonaws\.com\.cn$/.test(url.hostname)
		);
	} catch {
		return false;
	}

}

export default defineEventHandler(async (event) => {
	try {
		const raw = (await readRawBody(event)) || "";
		const sns = JSON.parse(raw as string);

		await verifySnsMessage(sns);

		// 1) One-time SNS handshake
		if (sns?.Type === "SubscriptionConfirmation" && sns.SubscribeURL) {

			if (!isSafeSnsSubscribeUrl(sns.SubscribeURL)) {
				throw new Error("Invalid SNS SubscribeURL");
			}
			await $fetch(sns.SubscribeURL, {
				method: "GET",
				redirect: "error",
			});
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
			// const size: number = rec.s3?.object?.size ?? 0;

			const parts = key.split("/");
			const [prefix, ownerId, providerId, identityId, emlId] = parts;
			if (
				parts.length !== 5 ||
				prefix !== "inbound" ||
				!ownerId ||
				!providerId ||
				!identityId ||
				!emlId
			) {
				console.warn("[Webhook] Unexpected S3 key layout, ignoring.", { key });
				return { ok: true };
			}

			// A validly signed SNS message can come from any AWS account's
			// topic: the key (owner/provider/identity) and bucket are attacker
			// controlled until they are checked against the stored provider.
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

			// The notification must come from the bucket/topic bootstrapped for
			// this provider; otherwise anyone could point us at arbitrary objects.
			const resourceIds = (provider.metaData as any)?.verification
				?.resourceIds as { bucket?: string; topicArn?: string } | undefined;
			if (!resourceIds?.bucket || resourceIds.bucket !== bucket) {
				console.warn("[Webhook] S3 bucket does not match provider", {
					bucket,
					providerId,
				});
				return { ok: true };
			}
			if (resourceIds.topicArn && resourceIds.topicArn !== sns.TopicArn) {
				console.warn("[Webhook] SNS topic does not match provider", {
					topicArn: sns.TopicArn,
					providerId,
				});
				return { ok: true };
			}

			const [identity] = await db
				.select()
				.from(identities)
				.where(
					and(
						eq(identities.id, identityId),
						eq(identities.workspaceId, provider.workspaceId),
					),
				);
			if (!identity) {
				console.warn("[Webhook] SES identity does not belong to provider", {
					identityId,
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

			// Parse once with the options parseAndStoreEmail needs and hand the
			// result over instead of parsing the message twice. (No full mail
			// dumps in the logs.)
			const parsed = await simpleParser(rawEmail, { keepCidLinks: true });
			const headers = parsed.headers as Map<string, any>;

			const userMailboxes = await db
				.select()
				.from(mailboxes)
				.where(
					and(
						eq(mailboxes.identityId, identity.id),
						eq(mailboxes.workspaceId, provider.workspaceId),
					),
				);

			const inbox = userMailboxes.find((m) => m.kind === "inbox");
			const spamMb = userMailboxes.find((m) => m.kind === "spam");

			if (!inbox) {
				console.warn("[Webhook] No inbox mailbox for SES identity", {
					identityId,
				});
				return { ok: true };
			}

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

			let targetMailboxId = inbox.id;
			if (providerSaysSpam && spamMb) {
				targetMailboxId = spamMb.id;
			}

			await parseAndStoreEmail(rawEmail, {
				ownerId,
				workspaceId: provider.workspaceId,
				mailboxId: targetMailboxId,
				rawStorageKey: key, // S3 key
				emlKey: emlId,
				parsed,
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
