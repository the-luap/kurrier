import { defineNitroPlugin } from "nitropack/runtime";
import {
	AddressObjectJSON,
	ComposeMode,
	getServerEnv,
	MailComposeInput,
} from "@schema";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import { generateSnippet, upsertMailboxThreadItem } from "@common";
const serverConfig = getServerEnv();
import { Worker } from "bullmq";
import {
	db,
	decryptAdminSecrets,
	draftMessages,
	identities,
	mailboxes,
	MessageAttachmentInsertSchema,
	messageAttachments,
	MessageCreate,
	MessageInsertSchema,
	messages,
	providers,
	providerSecrets,
	smtpAccounts,
	smtpAccountSecrets,
	threads,
	getSecretAdmin,
	jmapAccounts,
	workspaceMembers,
	workspaces,
} from "@db";
import { createMailer } from "@providers";
import { and, eq, isNotNull } from "drizzle-orm";
import addressparser from "addressparser";
import { getRedis, workerOptions } from "../../lib/get-redis";
import {GetObjectCommand, PutObjectCommand} from "@aws-sdk/client-s3";
import {s3} from "../../lib/create-s3-client";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

type DbTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

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
				// case "send-and-reconcile":
				// 	await send(job.data);
				// 	return { success: true };
				case "send-and-reconcile": {
					const result = await send(job.data);
					if (!result.success) {
						throw new Error(
							result.error ?? "Failed to send email",
						);
					}
					return result;
				}
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

	// Only messages of the sending identity's workspace may be quoted or
	// replied to (the id comes from the client).
	const getOriginalMessage = async (
		decodedForm: Record<any, any>,
		workspaceId: string,
	) => {
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
			.where(
				and(
					eq(messages.id, String(decodedForm.originalMessageId)),
					eq(messages.workspaceId, workspaceId),
				),
			);

		return message;
	};

	type GetOriginalMessageType = Awaited<ReturnType<typeof getOriginalMessage>>;

	async function ensureThreadId(ownerId: string, workspaceId: string, tx: DbTransaction) {
		const [t] = await tx
			.insert(threads)
			.values({
				ownerId,
				workspaceId,
				lastMessageDate: new Date(),
			})
			.returning({ id: threads.id });
		return t.id;
	}

	// Form fields arrive as comma separated strings (Mantine TagsInput) or
	// arrays. Parse them with addressparser so "Name, Jr. <a@b.c>" stays one
	// recipient and missing cc/bcc become [] instead of [undefined]. Only bare
	// addresses go to the providers (some reject unencoded names).
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
			if (!result.success) {
				throw new Error(result.error ?? "Failed to send email");
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

	const send = async (
		decodedForm: Record<any, unknown>,
	): Promise<{ success: boolean; error?: string }> => {
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

			const providerType =
				mailbox.provider?.type ?? "smtp";

			let credentials: Record<string, unknown>;

			if (providerType === "jmap") {
				const [jmapAccount] = await tx
					.select()
					.from(jmapAccounts)
					.where(
						and(
							eq(
								jmapAccounts.identityId,
								mailbox.identity.id,
							),
							eq(
								jmapAccounts.workspaceId,
								mailbox.identity.workspaceId,
							),
						),
					)
					.limit(1);

				if (!jmapAccount) {
					throw new Error(
						"JMAP account not found for identity",
					);
				}

				const { vault } = await getSecretAdmin(
					jmapAccount.tokenSecretId,
				);

				credentials = {
					token: vault.decrypted_secret,
					sessionUrl: jmapAccount.sessionUrl,
					accountId: jmapAccount.accountId,
					username: jmapAccount.username,
				};
			} else {
				const [secrets] = mailbox.identity.providerId
					? await decryptAdminSecrets({
						linkTable: providerSecrets,
						foreignCol: providerSecrets.providerId,
						secretIdCol: providerSecrets.secretId,
						ownerId: mailbox.identity.ownerId,
						parentId: String(
							mailbox.identity.providerId,
						),
					})
					: await decryptAdminSecrets({
						linkTable: smtpAccountSecrets,
						foreignCol: smtpAccountSecrets.accountId,
						secretIdCol: smtpAccountSecrets.secretId,
						ownerId: mailbox.identity.ownerId,
						parentId: String(
							mailbox.identity.smtpAccountId,
						),
					});

				credentials =
					secrets?.vault?.decrypted_secret
						? JSON.parse(
							secrets.vault.decrypted_secret,
						)
						: {};
			}

			const mailer = createMailer(
				providerType,
				credentials,
			);

			//


			const attachmentBlobs = await fetchAttachmentBlobs(
				decodedForm.attachments as string,
				{
					identityOwnerId: mailbox.identity.ownerId,
					workspaceId: mailbox.identity.workspaceId,
				},
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
				origRow =
					(await getOriginalMessage(
						decodedForm,
						mailbox.identity.workspaceId,
					)) ?? null;
			}

			const { subject, text, html } = await generateMailAttrs({
				data,
				orig: origRow,
				workspaceId: mailbox.identity.workspaceId,
			});

			const mailboxIdForMessage = String(decodedForm.sentMailboxId);

			let threadIdForMessage: string;

			if (data.mode === "reply") {
				if (!origRow?.message) throw new Error("Original message not found");
				threadIdForMessage = origRow.message.threadId;
			} else {
				threadIdForMessage = await ensureThreadId(
					mailbox.identity.ownerId,
					mailbox.mailbox.workspaceId,
					tx,
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
				workspaceId: mailbox.mailbox.workspaceId,
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
			if (decodedForm.apiMessageId) {
				newMessageBody.id = String(decodedForm.apiMessageId);
			}

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


				// The mail is already sent: a failed EML build/upload must not roll
				// back the stored message (the user would send it again).
				try {
					const emlBuffer = await buildEmlBuffer({
						messageId: String(mailerResponse.MessageId) || `msg-${Date.now()}`,
						from: mailbox.identity.value,
						to: data.to || [],
						cc: data.cc || [],
						bcc: data.bcc || [],
						subject: String(newMessage.subject || "(no subject)"),
						text: newMessage.text,
						html: newMessage.html,
						inReplyTo,
						references,
						attachments: attachmentBlobs,
					});
					const rawStorageKey = `eml/${newMessage.ownerId}/${newMessage.mailboxId}/${newMessage.id}.eml`;
					await s3.send(
						new PutObjectCommand({
							Bucket: serverConfig.S3_BUCKET,
							Key: rawStorageKey,
							Body: emlBuffer,
							ContentType: "message/rfc822",
						}),
					);
					await tx
						.update(messages)
						.set({
							rawStorageKey,
							sizeBytes: emlBuffer.length,
						})
						.where(eq(messages.id, newMessage.id));
				} catch (error) {
					console.error("[send-mail] failed to store sent EML", error);
				}




				if (attachmentBlobs.length) {
					await tx.insert(messageAttachments).values(
						attachmentBlobs.map((attachmentBlob) => ({
							...attachmentBlob.item,
							ownerId: newMessage.ownerId,
							workspaceId: mailbox.mailbox.workspaceId,
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
		// a Redis error rolled back the row of a mail that was already sent, and
		// the search worker could run before the row was visible. The mail is
		// sent at this point, so a failed enqueue must not turn the result into
		// an error (the user would send it again).
		if (indexMessageId) {
			try {
				const { searchIngestQueue } = await getRedis();
				await searchIngestQueue.add(
					"add",
					{ messageId: indexMessageId },
					{ removeOnComplete: true },
				);
			} catch (error) {
				console.error("[send-mail] failed to queue search indexing", error);
			}
		}
		return result;
	};

	const generateMailAttrs = async ({
										 data,
										 orig,
										 workspaceId,
									 }: {
		data: MailComposeInput;
		orig: GetOriginalMessageType | null;
		workspaceId: string;
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
				workspaceId,
			)
			: "";
		const origText = hasOrig ? origMsg!.text || "" : "";

		// Subject
		// The composer pre-fills "Re:"/"Fwd:" subjects; honour user edits and
		// only derive one from the original when the subject is empty.
		const baseSubj = (data.subject ?? "").trim();
		let subject = baseSubj;
		if (!baseSubj && isReply && hasOrig) {
			const s = (origMsg!.subject ?? "").trim();
			subject = /^(re|aw)\s*:/i.test(s) ? s : `Re: ${s || "(no subject)"}`;
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

		// The attribution and plain text come from the original sender: escape
		// them. Only the <body> content of the original HTML is nested.
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


	async function streamToBuffer(stream: any): Promise<Buffer> {
		return await new Promise((resolve, reject) => {
			const chunks: any[] = [];
			stream.on("data", (chunk: any) => chunks.push(chunk));
			stream.on("error", reject);
			stream.on("end", () => resolve(Buffer.concat(chunks)));
		});
	}

	// Inline images of stored messages reference their attachment via "cid:"
	// (messages are parsed with keepCidLinks). Quoted in a reply/forward those
	// references would break, so embed them as data URIs (bounded, so huge
	// mails do not explode).
	async function inlineCidImages(
		html: string,
		messageId: string,
		workspaceId: string,
	): Promise<string> {
		if (!html || !/cid:/i.test(html)) return html;
		const rows = await db
			.select()
			.from(messageAttachments)
			.where(
				and(
					eq(messageAttachments.messageId, messageId),
					eq(messageAttachments.workspaceId, workspaceId),
					isNotNull(messageAttachments.cid),
				),
			);
		let budget = 8 * 1024 * 1024;
		let out = html;
		for (const row of rows) {
			const cid = String(row.cid).replace(/^<|>$/g, "");
			const size = Number(row.sizeBytes ?? 0);
			if (!cid || !size || size > budget) continue;
			try {
				const response = await s3.send(
					new GetObjectCommand({
						Bucket: serverConfig.S3_BUCKET,
						Key: String(row.path),
					}),
				);
				if (!response.Body) continue;
				const buffer = await streamToBuffer(response.Body);
				budget -= buffer.length;
				const uri = `data:${row.contentType || "application/octet-stream"};base64,${buffer.toString("base64")}`;
				const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				out = out.replace(new RegExp(`cid:${escaped}`, "gi"), uri);
			} catch (err) {
				console.warn("[send-mail] could not inline quoted cid image", {
					messageId,
					path: row.path,
					error: (err as Error)?.message,
				});
			}
		}
		return out;
	}

	/**
	 * Users whose upload folder (`private/<userId>/`) the sender may attach
	 * from: the identity owner and the members of the identity's workspace.
	 */
	async function allowedUploadOwners(opts: {
		identityOwnerId: string;
		workspaceId: string;
	}) {
		const allowed = new Set<string>([opts.identityOwnerId]);
		const [workspace] = await db
			.select({ ownerId: workspaces.ownerId })
			.from(workspaces)
			.where(eq(workspaces.id, opts.workspaceId))
			.limit(1);
		if (workspace?.ownerId) allowed.add(workspace.ownerId);
		const members = await db
			.select({ userId: workspaceMembers.userId })
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, opts.workspaceId));
		for (const m of members) allowed.add(m.userId);
		return allowed;
	}

	async function fetchAttachmentBlobs(
		attachmentsString: string,
		owner: { identityOwnerId: string; workspaceId: string },
	): Promise<AttachmentDownload[]> {
		let attachments: unknown = [];
		try {
			attachments = attachmentsString ? JSON.parse(attachmentsString) : [];
		} catch {
			throw new Error("Invalid attachments payload");
		}

		const list = Array.isArray(attachments) ? attachments : [];
		const candidates = list.filter((a: any) => a && a.path);

		if (candidates.length === 0) return [];

		// The list comes from the browser (or API caller) and is downloaded with
		// the worker's bucket credentials: only allow files from the upload
		// folder of a user of the sending identity's workspace
		// (`private/<userId>/...`), never other users' EMLs or attachments.
		const allowed = await allowedUploadOwners(owner);
		for (const a of candidates as any[]) {
			const path = String(a.path);
			const [prefix, userId, ...rest] = path.split("/");
			if (
				prefix !== "private" ||
				!userId ||
				!allowed.has(userId) ||
				rest.length === 0 ||
				path.includes("..") ||
				path.includes("//")
			) {
				throw new Error("Invalid attachment");
			}
		}

		// A failed download aborts sending instead of silently sending the
		// mail without its attachments.
		return await Promise.all(
			candidates.map(async (attachment: any): Promise<AttachmentDownload> => {
				const command = new GetObjectCommand({
					Bucket: serverConfig.S3_BUCKET,
					Key: String(attachment.path),
				});

				const response = await s3.send(command);

				if (!response.Body) {
					throw new Error(`Failed to download "${attachment.path}"`);
				}

				const buffer = await streamToBuffer(response.Body);

				const item = MessageAttachmentInsertSchema.parse(attachment);
				const uint8 = new Uint8Array(buffer);

				return {
					item,
					blob: new Blob([uint8], {
						type: String(attachment.contentType || "application/octet-stream"),
					}),
					name: String(attachment.filenameOriginal || "attachment"),
					sizeBytes: buffer.length,
				};
			}),
		);
	}


	async function blobToBuffer(blob: Blob) {
		return Buffer.from(await blob.arrayBuffer());
	}

	async function buildEmlBuffer(opts: {
		messageId: string;
		from: string;
		to: string[];
		cc?: string[];
		bcc?: string[];
		subject: string;
		text?: string | null;
		html?: string | null;
		inReplyTo?: string | null;
		references?: string[];
		attachments: AttachmentDownload[];
	}) {
		const composer = new MailComposer({
			messageId: opts.messageId,
			from: opts.from,
			to: opts.to,
			cc: opts.cc,
			bcc: opts.bcc,
			subject: opts.subject,
			text: opts.text || "",
			html: opts.html || "",
			inReplyTo: opts.inReplyTo || undefined,
			references: opts.references?.length ? opts.references : undefined,
			attachments: await Promise.all(
				opts.attachments.map(async (att) => ({
					filename: att.name,
					content: await blobToBuffer(att.blob),
					contentType: String(att.item.contentType || "application/octet-stream"),
				})),
			),
		});

		return await new Promise<Buffer>((resolve, reject) => {
			composer.compile().build((err, message) => {
				if (err) reject(err);
				else resolve(message);
			});
		});
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
