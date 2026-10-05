import { generateSnippet, upsertMailboxThreadItem } from "@common";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import {
	type AddressObjectJSON,
	type ComposeMode,
	getPublicEnv,
	getServerEnv,
	type MailComposeInput,
} from "@schema";
import { defineNitroPlugin } from "nitropack/runtime";

const serverConfig = getServerEnv();
const publicConfig = getPublicEnv();

import {
	db,
	decryptAdminSecrets,
	draftMessages,
	identities,
	MessageAttachmentInsertSchema,
	type MessageCreate,
	MessageInsertSchema,
	mailboxes,
	messageAttachments,
	messages,
	providerSecrets,
	providers,
	smtpAccountSecrets,
	smtpAccounts,
	threads,
} from "@db";
import { createMailer } from "@providers";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Worker } from "bullmq";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

const supabase = createClient(
	publicConfig.API_URL,
	serverConfig.SERVICE_ROLE_KEY,
);

import addressparser from "addressparser";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { getRedis, workerOptions } from "../../lib/get-redis";

type AttachmentDownload = {
	item: ReturnType<typeof MessageAttachmentInsertSchema.parse>;
	blob: Blob;
	name: string;
	sizeBytes: number;
	contentType?: string;
};

export default defineNitroPlugin(async (nitroApp) => {
	const worker = new Worker(
		"send-mail",
		async (job) => {
			switch (job.name) {
				case "send-scheduled-draft":
					await processDraft(job.data);
					return { success: true };
				case "send-and-reconcile":
					// Propagate provider errors to the UI instead of reporting success.
					return (await send(job.data)) ?? { success: true };
				default:
					return { success: true };
			}
		},
		workerOptions(),
	);

	worker.on("completed", (job) => {
		console.log(`[send-mail] ${job.id} completed`);
	});
	worker.on("failed", (job, err) => {
		console.error(`[send-mail] ${job?.id} failed: ${err?.message}`);
	});

	const getOriginalMessage = async (decodedForm: Record<any, any>) => {
		const [message] = await db
			.select({
				message: messages,
				mailbox: mailboxes,
				identity: identities,
				provider: providers,
				smtpAccount: smtpAccounts,
			})
			.from(messages)
			.leftJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
			.leftJoin(identities, eq(mailboxes.identityId, identities.id))
			.leftJoin(providers, eq(identities.providerId, providers.id))
			.leftJoin(smtpAccounts, eq(identities.smtpAccountId, smtpAccounts.id))
			.where(eq(messages.id, String(decodedForm.originalMessageId)));

		return message;
	};

	type GetOriginalMessageType = Awaited<ReturnType<typeof getOriginalMessage>>;

	async function ensureThreadId(ownerId: string, tx: PgTransaction<any>) {
		const [t] = await tx
			.insert(threads)
			.values({
				ownerId,
				lastMessageDate: new Date(),
			})
			.returning({ id: threads.id });
		return t.id;
	}

	// Form fields arrive as comma separated strings (Mantine TagsInput) or arrays.
	// Parse them with addressparser so "Name, Jr. <a@b.c>" stays one recipient.
	// Only bare addresses go to the providers (some reject unencoded names).
	function toArray(input: unknown): string[] {
		const list = Array.isArray(input) ? input : [input];
		const out: string[] = [];
		for (const entry of list) {
			const str = String(entry ?? "").trim();
			if (!str) continue;
			for (const p of addressparser(str)) {
				if (p.address) out.push(p.address);
			}
		}
		return Array.from(new Set(out));
	}

	function escapeHtml(value: string) {
		return value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	// Stored messages may be complete HTML documents. Only the <body> content
	// can be nested inside a <blockquote>; the original <style> blocks are
	// dropped because they would also restyle the new reply text.
	function extractBodyHtml(html: string) {
		const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
		let body = bodyMatch ? bodyMatch[1] : html;
		if (!bodyMatch) {
			body = body
				.replace(/<!doctype[^>]*>/gi, "")
				.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
				.replace(/<\/?html\b[^>]*>/gi, "");
		}
		return body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
	}

	function toAddressObj(
		input: string | string[] | null | undefined,
	): AddressObjectJSON {
		const str = Array.isArray(input) ? input.join(",") : input || "";
		const parsed = addressparser(str);
		const value = parsed.map((p) => ({
			address: p.address || null,
			name: p.name || "",
		}));
		const joined = value
			.map((v: { name: any; address: any }) =>
				v.name ? `${v.name} <${v.address ?? ""}>` : (v.address ?? ""),
			)
			.join(", ");
		return { value, html: joined, text: joined };
	}

	const processDraft = async ({
		draftMessageId,
	}: {
		draftMessageId: string;
	}) => {
		const [draft] = await db
			.select()
			.from(draftMessages)
			.where(eq(draftMessages.id, draftMessageId))
			.limit(1);

		if (!draft) throw new Error("Draft not found");

		const claimed = await db
			.update(draftMessages)
			.set({ status: "sending", updatedAt: new Date() })
			.where(
				and(
					eq(draftMessages.id, draft.id),
					eq(draftMessages.status, "scheduled"),
				),
			)
			.returning({ id: draftMessages.id });

		if (claimed.length === 0) return;

		try {
			const result = await send(draft.payload);
			if (result && result.success === false) {
				throw new Error(result.error || "Failed to send email");
			}

			await db
				.update(draftMessages)
				.set({ status: "sent", updatedAt: new Date() })
				.where(eq(draftMessages.id, draft.id));
		} catch (err: any) {
			await db
				.update(draftMessages)
				.set({
					status: "failed",
					payload: {
						...draft.payload,
						__error: err?.message ? String(err.message) : String(err),
					},
					updatedAt: new Date(),
				})
				.where(eq(draftMessages.id, draft.id));

			throw err;
		}
	};

	const send = async (decodedForm: Record<any, unknown>) => {
		let indexMessageId: string | null = null;
		const result = await db.transaction(async (tx) => {
			const [mailbox] = await tx
				.select({
					mailbox: mailboxes,
					identity: identities,
					provider: providers,
					smtp: smtpAccounts,
				})
				.from(mailboxes)
				.leftJoin(identities, eq(mailboxes.identityId, identities.id))
				.leftJoin(providers, eq(identities.providerId, providers.id))
				.leftJoin(smtpAccounts, eq(identities.smtpAccountId, smtpAccounts.id))
				.where(eq(mailboxes.id, String(decodedForm.sentMailboxId)));

			if (!mailbox) {
				throw new Error("Mailbox not found");
			}

			const [secrets] = mailbox.identity.providerId
				? await decryptAdminSecrets({
						linkTable: providerSecrets,
						foreignCol: providerSecrets.providerId,
						secretIdCol: providerSecrets.secretId,
						ownerId: mailbox.identity.ownerId,
						parentId: String(mailbox.identity.providerId),
					})
				: await decryptAdminSecrets({
						linkTable: smtpAccountSecrets,
						foreignCol: smtpAccountSecrets.accountId,
						secretIdCol: smtpAccountSecrets.secretId,
						ownerId: mailbox.identity.ownerId,
						parentId: String(mailbox.identity.smtpAccountId),
					});

			const credentials = secrets?.vault?.decrypted_secret
				? JSON.parse(secrets.vault.decrypted_secret)
				: {};

			const mailer = createMailer(
				mailbox.provider ? mailbox.provider.type : "smtp",
				credentials,
			);

			const attachmentBlobs = await fetchAttachmentBlobs(
				supabase,
				decodedForm.attachments as string,
				mailbox.identity.ownerId,
			);

			const data: MailComposeInput = {
				messageId: String(decodedForm.messageId ?? ""),
				to: toArray(decodedForm.to as any),
				cc: toArray(decodedForm.cc as any),
				bcc: toArray(decodedForm.bcc as any),
				subject: (decodedForm.subject as string) || undefined,
				text: (decodedForm.text as string) || undefined,
				html: (decodedForm.html as string) || undefined,
				mode: (decodedForm.mode as ComposeMode) || "new",
			};

			let origRow: GetOriginalMessageType | null = null;
			if (
				(data.mode === "reply" || data.mode === "forward") &&
				decodedForm.originalMessageId
			) {
				origRow = await getOriginalMessage(decodedForm);
			}

			const { subject, text, html } = await generateMailAttrs({
				data,
				orig: origRow,
				ownerId: mailbox.identity.ownerId,
			});

			// Forwarding: include the attachments of the original message the
			// user kept in the editor.
			if (data.mode === "forward" && origRow?.message) {
				const forwardIds = String(decodedForm.forwardAttachmentIds ?? "")
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
				if (forwardIds.length > 0) {
					attachmentBlobs.push(
						...(await fetchForwardedAttachments(
							origRow.message.id,
							forwardIds,
							mailbox.identity.ownerId,
						)),
					);
				}
			}

			const mailboxIdForMessage = String(decodedForm.sentMailboxId);

			let threadIdForMessage: string;

			if (data.mode === "reply") {
				if (!origRow?.message) throw new Error("Original message not found");
				threadIdForMessage = origRow.message.threadId;
			} else {
				threadIdForMessage = await ensureThreadId(
					mailbox.identity.ownerId,
					tx as PgTransaction<any>,
				);
			}

			const inReplyTo =
				data.mode === "reply" && origRow?.message
					? origRow.message.messageId
					: null;

			const references =
				data.mode === "reply" && origRow?.message
					? Array.from(
							new Set(
								[
									...(Array.isArray(origRow.message.references)
										? origRow.message.references
										: []),
									origRow.message.messageId ?? null,
								].filter(Boolean),
							),
						).slice(-30)
					: [];

			const newMessageBody = MessageInsertSchema.parse({
				mailboxId: mailboxIdForMessage,
				threadId: threadIdForMessage,
				messageId: "PLACEHOLDER",
				inReplyTo: inReplyTo ?? undefined,
				references,
				hasAttachments: attachmentBlobs.length > 0,
				to: toAddressObj(data.to || []),
				from: mailbox.identity.value,
				cc: toAddressObj(data?.cc || []),
				bcc: toAddressObj(data.bcc || []),
				snippet: generateSnippet(text || html || ""),
				subject,
				text,
				html,
				ownerId: mailbox.identity.ownerId,
				seen: true,
			});

			const mailerResponse = await mailer.sendEmail(data.to, {
				from: mailbox.identity.value,
				cc: data.cc,
				bcc: data.bcc,
				subject: String(newMessageBody.subject),
				text: newMessageBody.text ?? "",
				html: newMessageBody.html ?? "",
				inReplyTo: inReplyTo ?? "",
				references: references,
				attachments: attachmentBlobs.map((att) => ({
					name: att.name,
					content: att.blob,
					contentType: String(att.item.contentType),
				})),
			});

			if (mailerResponse.success) {
				const parsedMessage = MessageInsertSchema.parse({
					...newMessageBody,
					messageId: String(mailerResponse.MessageId) || `msg-${Date.now()}`,
				});

				const [newMessage] = await tx
					.insert(messages)
					.values(parsedMessage as MessageCreate)
					.returning();

				if (attachmentBlobs.length) {
					await tx.insert(messageAttachments).values(
						attachmentBlobs.map((attachmentBlob) => ({
							...attachmentBlob.item,
							ownerId: newMessage.ownerId,
							messageId: newMessage.id,
						})),
					);
				}

				await upsertMailboxThreadItem(newMessage.id, tx);

				indexMessageId = newMessage.id;
			} else {
				// Some providers only return { success: false } without details.
				return {
					success: false,
					error: mailerResponse.error
						? `Failed to send email: ${mailerResponse.error}`
						: "Failed to send email. Check the provider settings of this identity.",
				};
			}
			return { success: true };
		});

		// Enqueue indexing only after the transaction committed: from inside it
		// the search worker could run before the message row was visible.
		if (indexMessageId) {
			const { searchIngestQueue } = await getRedis();
			await searchIngestQueue.add(
				"add",
				{ messageId: indexMessageId },
				{ removeOnComplete: true },
			);
		}
		return result;
	};

	const generateMailAttrs = async ({
		data,
		orig,
		ownerId,
	}: {
		data: MailComposeInput;
		orig: GetOriginalMessageType | null;
		ownerId: string;
	}) => {
		if (!orig) {
			return {
				subject: data.subject ?? "(no subject)",
				text: data.text ?? "",
				html: data.html ?? "",
			};
		}
		const isReply = data.mode === "reply";
		const isForward = data.mode === "forward";
		const hasOrig = Boolean(orig?.message);

		const origMsg = orig?.message ?? null;

		const fromNameStr = hasOrig ? getMessageName(origMsg!, "from") || "" : "";
		const fromAddrStr = hasOrig
			? getMessageAddress(origMsg!, "from") || ""
			: "";

		// Prefer RFC822 Date, then createdAt, else empty
		const rawDate: Date | null =
			hasOrig && (origMsg!.date ?? origMsg!.createdAt)
				? (origMsg!.date ?? origMsg!.createdAt)!
				: null;

		// Human-friendly fallback
		const origDateLabel = rawDate
			? new Date(rawDate).toLocaleString(undefined, {
					year: "numeric",
					month: "short",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				})
			: "";

		const origHtml = hasOrig
			? await inlineCidImages(
					origMsg!.html || origMsg!.textAsHtml || "",
					origMsg!.id,
					ownerId,
				)
			: "";
		const origText = hasOrig ? origMsg!.text || "" : "";

		// Subject
		// The compose form pre-fills "Re:"/"Fwd:" subjects; honour user edits.
		const baseSubj = (data.subject ?? "").trim();
		let subject = baseSubj;
		if (!baseSubj && isReply && hasOrig) {
			const s = (origMsg!.subject ?? "").trim();
			subject = /^re\s*:/i.test(s) ? s : `Re: ${s || "(no subject)"}`;
		} else if (!baseSubj && isForward && hasOrig) {
			const s = (origMsg!.subject ?? "").trim();
			subject = /^(fwd?|wg)\s*:/i.test(s) ? s : `Fwd: ${s || "(no subject)"}`;
		} else if (!baseSubj) {
			subject = "(no subject)";
		}

		// Quoted blocks (only with original)
		const attribution = `On ${origDateLabel}, ${fromNameStr ? `${fromNameStr} ` : ""}<${fromAddrStr}> wrote:`;
		const quotedText = hasOrig
			? `${attribution}\n${origText
					.split(/\r?\n/)
					.map((line: string) => (line ? `> ${line}` : ">"))
					.join("\n")}`
			: "";

		const quotedHtml = hasOrig
			? `<br><div class="kurrier_quote">
<p>${escapeHtml(attribution)}</p>
<blockquote type="cite" style="border-left:2px solid #ccc;margin:0 0 0 0.8ex;padding-left:1ex;">
${origHtml ? extractBodyHtml(origHtml) : `<pre style="white-space:pre-wrap;margin:0;font-family:inherit;">${escapeHtml(origText)}</pre>`}
</blockquote>
</div>`
			: "";

		// Bodies
		const text = isReply
			? `${data.text ?? ""}${hasOrig ? `\n\n${quotedText}` : ""}`
			: isForward
				? `${data.text ?? ""}${hasOrig ? `\n\nForwarded message:\n${quotedText}` : ""}`
				: (data.text ?? "");

		const html = isReply
			? `${data.html ?? ""}${quotedHtml}`
			: isForward
				? `${data.html ?? ""}${hasOrig ? `<p>Forwarded message:</p>${quotedHtml}` : ""}`
				: (data.html ?? ""); // for "new", don't auto-pull orig html

		return { subject, text, html };
	};

	// Inline images of stored messages reference their attachment via "cid:".
	// Quoted in a reply/forward those references would break, so embed them
	// as data URIs (bounded, so huge mails do not explode).
	async function inlineCidImages(
		html: string,
		messageId: string,
		ownerId: string,
	): Promise<string> {
		if (!html || !/cid:/i.test(html)) return html;
		const rows = await db
			.select()
			.from(messageAttachments)
			.where(
				and(
					eq(messageAttachments.messageId, messageId),
					eq(messageAttachments.ownerId, ownerId),
					isNotNull(messageAttachments.cid),
				),
			);
		let budget = 8 * 1024 * 1024;
		let out = html;
		for (const row of rows) {
			const cid = String(row.cid).replace(/^<|>$/g, "");
			if (!cid || !(row.sizeBytes ?? 0) || (row.sizeBytes ?? 0) > budget)
				continue;
			const { data: blob } = await supabase.storage
				.from(String(row.bucketId || "attachments"))
				.download(String(row.path));
			if (!blob) continue;
			budget -= blob.size;
			const b64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
			const uri = `data:${row.contentType || "application/octet-stream"};base64,${b64}`;
			const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			out = out.replace(new RegExp(`cid:${escaped}`, "gi"), uri);
		}
		return out;
	}

	async function fetchForwardedAttachments(
		originalMessageId: string,
		ids: string[],
		ownerId: string,
	): Promise<AttachmentDownload[]> {
		const rows = await db
			.select()
			.from(messageAttachments)
			.where(
				and(
					eq(messageAttachments.messageId, originalMessageId),
					eq(messageAttachments.ownerId, ownerId),
					inArray(messageAttachments.id, ids),
				),
			);
		return Promise.all(
			rows.map(async (row): Promise<AttachmentDownload> => {
				const { data: blob, error } = await supabase.storage
					.from(String(row.bucketId || "attachments"))
					.download(String(row.path));
				if (error || !blob) {
					throw new Error(
						`Could not load attachment "${row.filenameOriginal ?? row.path}" to forward`,
					);
				}
				const item = MessageAttachmentInsertSchema.parse({
					bucketId: row.bucketId,
					path: row.path,
					filenameOriginal: row.filenameOriginal,
					contentType: row.contentType,
					sizeBytes: row.sizeBytes,
					checksum: row.checksum,
					disposition: "attachment",
				});
				return {
					item,
					blob,
					name: String(row.filenameOriginal || "attachment"),
					sizeBytes: Number(row.sizeBytes ?? blob.size),
				};
			}),
		);
	}

	async function fetchAttachmentBlobs(
		supabase: SupabaseClient,
		attachmentsString: string,
		ownerId: string,
	): Promise<AttachmentDownload[]> {
		let attachments: unknown = [];
		try {
			attachments = attachmentsString ? JSON.parse(attachmentsString) : [];
		} catch {
			return [];
		}

		const list = Array.isArray(attachments) ? attachments : [];
		const candidates = list.filter((a: any) => a && a.bucketId && a.path);

		if (candidates.length === 0) return [];

		// The list comes from the browser and is downloaded with the service
		// role: only allow files from the sender's own upload folder.
		const ownPrefix = `private/${ownerId}/`;
		for (const a of candidates as any[]) {
			const path = String(a.path);
			if (
				String(a.bucketId) !== "attachments" ||
				!path.startsWith(ownPrefix) ||
				path.includes("..")
			) {
				throw new Error("Invalid attachment");
			}
		}

		{
			const downloads = await Promise.all(
				candidates.map(async (attachment: any): Promise<AttachmentDownload> => {
					const { data: blob, error } = await supabase.storage
						.from(String(attachment.bucketId))
						.download(String(attachment.path));

					if (error || !blob) {
						throw new Error(
							`Failed to download "${attachment.path}": ${error?.message ?? "unknown error"}`,
						);
					}

					const sizeBytes = Number(attachment.sizeBytes ?? blob.size);

					const item = MessageAttachmentInsertSchema.parse(attachment);

					return {
						item,
						blob,
						name: String(attachment.filenameOriginal || "attachment"),
						sizeBytes,
						// contentType,
					};
				}),
			);

			// A failed download aborts sending instead of silently dropping it.
			return downloads;
		}
	}

	nitroApp.hooks.hookOnce("close", async () => {
		console.log("Closing nitro server...");
		console.log("Task is done!");
		try {
			await worker.close();
		} catch (err: any) {
			console.error("Error closing send mail worker:", err?.message ?? err);
		}
	});
});
