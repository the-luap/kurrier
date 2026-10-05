"use client";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import type {
	MailSubscriptionEntity,
	MessageAttachmentEntity,
	MessageEntity,
} from "@db";
import { ActionIcon, Button, Menu, Modal } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { PublicConfig } from "@schema";
import slugify from "@sindresorhus/slugify";
import {
	Ban,
	Code,
	Download,
	EllipsisVertical,
	Forward,
	Mail,
	MailOpen,
	Reply,
	Trash2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import EditorAttachmentItem from "@/components/mailbox/default/editor/editor-attachment-item";
import type {
	EmailEditorHandle,
	InitialDraft,
} from "@/components/mailbox/default/editor/email-editor";
import type { AuthStatus } from "@/components/mailbox/default/auth-status";
import MailUnsubscriber from "@/components/mailbox/default/mail-unsubscriber";
import {
	type FetchIdentityMailboxListResult,
	fetchDraftForMessage,
	fetchIdentityMailboxList,
	fetchMailbox,
	markAsRead,
	markAsUnread,
	moveToSpam,
	moveToTrash,
} from "@/lib/actions/mailbox";
import { createClient } from "@/lib/supabase/client";

const EmailEditor = dynamic(
	() => import("@/components/mailbox/default/editor/email-editor"),
	{
		ssr: false,
		loading: () => (
			<div className="py-10 text-sm text-muted-foreground">Loading editor…</div>
		),
	},
);

function formatAddressList(message: MessageEntity, field: "to" | "cc"): string {
	const value = (message as any)?.[field];
	if (!value) return "";
	if (typeof value === "string") return value;
	const list: { name?: string | null; address?: string | null }[] =
		value.value ?? [];
	return list
		.map((v) =>
			v.name && v.address
				? `${v.name} <${v.address}>`
				: (v.address ?? v.name ?? ""),
		)
		.filter(Boolean)
		.join(", ");
}

// Viewer-local formatting (same output as the former Temporal polyfill code,
// without shipping the polyfill to the thread view).
const headerDateFormatter = new Intl.DateTimeFormat("en-US", {
	day: "2-digit",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hour12: true,
});
const originalDateFormatter = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

function authClass(value: string) {
	if (value === "pass") return "text-green-700 dark:text-green-400";
	if (value === "fail") return "text-red-700 dark:text-red-400";
	if (value === "warn") return "text-amber-700 dark:text-amber-400";
	return "text-muted-foreground";
}

function getScrollParent(el: HTMLElement): HTMLElement {
	let p: HTMLElement | null = el.parentElement;
	while (p) {
		const s = getComputedStyle(p);
		const overflowY = s.overflowY || s.overflow;
		const canScrollY =
			(overflowY === "auto" || overflowY === "scroll") &&
			p.scrollHeight > p.clientHeight;
		if (canScrollY) return p;
		p = p.parentElement;
	}
	return (document.scrollingElement || document.documentElement) as HTMLElement;
}

export function scrollToEditor(
	el: HTMLElement,
	{ offsetTop = 96, minBottomGap = 48 } = {},
) {
	const container = getScrollParent(el);
	const isWindow = container === (document.scrollingElement as HTMLElement);

	const cRect = isWindow
		? ({ top: 10, height: window.innerHeight } as any)
		: container.getBoundingClientRect();
	const eRect = el.getBoundingClientRect();
	const currentTop = isWindow ? window.scrollY : container.scrollTop;

	// Place the editor top just below the sticky header
	const targetTop = currentTop + (eRect.top - cRect.top) - offsetTop;

	const doScroll = (top: number) => {
		if (isWindow) window.scrollTo({ top, behavior: "smooth" });
		else container.scrollTo({ top, behavior: "smooth" });
	};

	doScroll(targetTop);

	setTimeout(() => {
		const e2 = el.getBoundingClientRect();
		const viewH = isWindow
			? window.innerHeight
			: (container as HTMLElement).clientHeight;
		const bottomGap = viewH - e2.bottom;
		if (bottomGap < minBottomGap) {
			const delta = minBottomGap - bottomGap;
			if (isWindow) window.scrollBy({ top: delta, behavior: "smooth" });
			else
				(container as HTMLElement).scrollBy({ top: delta, behavior: "smooth" });
		}
	}, 120);
}

function EmailRenderer({
	threadIndex,
	numberOfMessages,
	message,
	attachments,
	publicConfig,
	threadId,
	markSmtp,
	activeMailboxId,
	mailSubscription,
	authStatus,
	attachmentUrls,
	children,
}: {
	threadIndex: number;
	numberOfMessages: number;
	message: MessageEntity;
	attachments: MessageAttachmentEntity[];
	publicConfig: PublicConfig;
	threadId: string;
	markSmtp: boolean;
	activeMailboxId: string;
	mailSubscription: MailSubscriptionEntity | null;
	authStatus?: AuthStatus | null;
	/** Server-signed download URLs by attachment id. */
	attachmentUrls?: Record<string, string>;
	children?: React.ReactNode;
}) {
	const receivedAt = message.date ?? message.createdAt;
	const [formatted, setFormatted] = useState("");
	const [formattedTime, setFormattedTime] = useState("");

	const [showEditor, setShowEditor] = useState<boolean>(false);
	const [showEditorMode, setShowEditorMode] = useState<string>("reply");
	const editorRef = useRef<EmailEditorHandle>(null);
	const seenRef = useRef(false);
	const router = useRouter();
	const [isRead, setIsRead] = useState(Boolean(message.seen));
	const [isMutating, setIsMutating] = useState(false);

	const [sentMailboxId, setSentMailboxId] = useState<string | undefined>(
		undefined,
	);
	const [signatureHtml, setSignatureHtml] = useState<string>("");
	const [isOpeningEditor, setIsOpeningEditor] = useState(false);
	const [initialDraft, setInitialDraft] = useState<InitialDraft>(null);
	const params = useParams();
	const findSentMailbox = (entry: FetchIdentityMailboxListResult[number]) =>
		entry.mailboxes.find((mailbox) => mailbox.kind === "sent") ??
		entry.mailboxes.find((mailbox) => mailbox.slug === "sent") ??
		entry.mailboxes.find((mailbox) => mailbox.slug === "gesendet") ??
		entry.mailboxes.find((mailbox) =>
			mailbox.name?.toLowerCase().includes("sent"),
		) ??
		entry.mailboxes.find((mailbox) =>
			mailbox.name?.toLowerCase().includes("gesendet"),
		);

	const fetchSentMailbox = async () => {
		if (sentMailboxId) return sentMailboxId;
		const identityPublicId = String(params.identityPublicId);
		const entries = await fetchIdentityMailboxList();
		const activeEntry = entries.find(
			(entry) => entry.identity.publicId === identityPublicId,
		);
		const sentMailbox = activeEntry ? findSentMailbox(activeEntry) : null;
		if (sentMailbox) {
			const id = String(sentMailbox.id);
			setSentMailboxId(id);
			setSignatureHtml(activeEntry?.identity.signatureHtml ?? "");
			return id;
		}

		const { activeMailbox, identity } = await fetchMailbox(
			identityPublicId,
			"sent",
		);
		setSignatureHtml(identity?.signatureHtml ?? "");
		const id = activeMailbox?.id ? String(activeMailbox.id) : undefined;
		setSentMailboxId(id);
		return id;
	};

	// The sent mailbox and signature must be known before the editor mounts:
	// the editor reads them once, and a late signature would wipe the draft.
	const openEditor = async (mode: "reply" | "forward") => {
		if (showEditor) {
			// Switching mode starts a fresh editor (not the stored draft).
			setInitialDraft(null);
			setShowEditorMode(mode);
			return;
		}
		setShowEditorMode(mode);
		setIsOpeningEditor(true);
		try {
			const [mailboxId, draft] = await Promise.all([
				fetchSentMailbox(),
				fetchDraftForMessage(String(message.id)).catch(() => null),
			]);
			if (!mailboxId) {
				throw new Error(
					"Kurrier could not resolve the Sent mailbox for this identity.",
				);
			}
			if (draft) {
				setInitialDraft({ id: draft.id, payload: draft.payload as any });
				const draftMode = (draft.payload as any)?.mode;
				if (draftMode === "reply" || draftMode === "forward") {
					setShowEditorMode(draftMode);
				}
				toast.info("Restored your draft", { position: "bottom-left" });
			} else {
				setInitialDraft(null);
			}
			setShowEditor(true);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not open editor",
				{ position: "bottom-left" },
			);
		} finally {
			setIsOpeningEditor(false);
		}
	};

	useEffect(() => {
		if (activeMailboxId && threadIndex === 0 && !seenRef.current) {
			seenRef.current = true;
			setIsRead(true);
			void markAsRead(threadId, activeMailboxId, markSmtp, false);
		}
	}, [activeMailboxId, markSmtp, threadId, threadIndex]);

	const mailboxHref = `/dashboard/mail/${String(params.identityPublicId)}/${String(params.mailboxSlug)}`;

	const markThreadReadState = async (read: boolean) => {
		if (!activeMailboxId || isMutating) return;
		const previous = isRead;
		setIsRead(read);
		setIsMutating(true);
		try {
			if (read) {
				await markAsRead(threadId, activeMailboxId, markSmtp, true);
				toast.success("Marked as read", { position: "bottom-left" });
			} else {
				await markAsUnread(threadId, activeMailboxId, markSmtp, true);
				toast.success("Marked as unread", { position: "bottom-left" });
			}
			router.refresh();
		} catch (error) {
			setIsRead(previous);
			toast.error(error instanceof Error ? error.message : "Action failed", {
				position: "bottom-left",
			});
		} finally {
			setIsMutating(false);
		}
	};

	const moveThreadOut = async (target: "trash" | "spam") => {
		if (!activeMailboxId || isMutating) return;
		setIsMutating(true);
		try {
			if (target === "trash") {
				await moveToTrash(threadId, activeMailboxId, markSmtp, true);
				toast.success("Message moved to Trash", { position: "bottom-left" });
			} else {
				await moveToSpam(threadId, activeMailboxId, markSmtp, true);
				toast.success("Message marked as spam", { position: "bottom-left" });
			}
			router.push(mailboxHref);
			router.refresh();
		} catch (error) {
			setIsMutating(false);
			toast.error(error instanceof Error ? error.message : "Action failed", {
				position: "bottom-left",
			});
		}
	};

	const downloadEml = async () => {
		if (!message.rawStorageKey) {
			toast.error("Raw .eml source is not available for this message", {
				position: "bottom-left",
			});
			return;
		}
		const supabase = createClient(publicConfig);
		const { data, error } = await supabase.storage
			.from("attachments")
			.createSignedUrl(String(message.rawStorageKey), 3600, {
				download: true,
			});
		if (error) {
			toast.error(error.message || "Could not create download URL", {
				position: "bottom-left",
			});
			return;
		}
		if (data?.signedUrl) {
			window.open(data.signedUrl, "_blank", "noopener,noreferrer");
		}
	};

	const [opened, { open, close }] = useDisclosure(false);
	const [emailString, setEmailString] = useState<string | null>(null);

	useEffect(() => {
		if (!opened || emailString) return;
		if (!message.rawStorageKey) {
			setEmailString("Raw .eml source is not available for this message.");
			return;
		}
		// Ignore a late response once the modal is closed / message changes.
		let cancelled = false;
		const supabase = createClient(publicConfig);
		supabase.storage
			.from("attachments")
			.download(String(message.rawStorageKey))
			.then(async ({ data, error }) => {
				if (error) {
					console.error("Error downloading original message:", error);
					return;
				}
				if (!data) return;
				const raw = await data.text();
				if (cancelled) return;
				setEmailString(
					raw.length > 200_000
						? `${raw.slice(0, 200_000)}\n\n… truncated, use "Download" for the full message.`
						: raw,
				);
			});
		return () => {
			cancelled = true;
		};
	}, [opened, emailString, publicConfig, message.rawStorageKey]);

	useEffect(() => {
		const date = new Date(receivedAt);
		if (Number.isNaN(date.getTime())) return;
		setFormatted(headerDateFormatter.format(date));
		setFormattedTime(originalDateFormatter.format(date).replace(",", " at"));
	}, [receivedAt]);

	return (
		<>
			<Modal opened={opened} onClose={close} title="Original message" size="xl">
				<div className="text-sm border rounded-md overflow-hidden">
					{/* Header Rows */}
					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							Message ID
						</div>
						<div className="px-3 py-2 text-green-700 break-all">
							{message.messageId}
						</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							Received
						</div>
						<div className="px-3 py-2" suppressHydrationWarning>
							{formattedTime}
						</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							From
						</div>
						<div className="px-3 py-2">
							{message?.headersJson?.from?.text ?? ""}
						</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							To
						</div>
						{/*<div className="px-3 py-2">suisse@dinebot.io</div>*/}
						<div className="px-3 py-2">
							{message?.headersJson?.to?.text ?? ""}
						</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							Subject
						</div>
						<div className="px-3 py-2">
							{/*Google Workspace: Your invoice is available for dinebot.io*/}
							{message?.headersJson?.subject}
						</div>
					</div>

					{authStatus &&
						(["spf", "dkim", "dmarc"] as const).map((kind) => (
							<div key={kind} className="grid grid-cols-[160px_1fr] border-b">
								<div className="bg-muted px-3 py-2 font-medium uppercase text-muted-foreground">
									{kind}
								</div>
								<div
									className={`px-3 py-2 font-semibold uppercase ${authClass(authStatus[kind])}`}
								>
									{authStatus[kind]}
								</div>
							</div>
						))}
					{authStatus?.authResults && (
						<div className="grid grid-cols-[160px_1fr]">
							<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
								Authentication-Results
							</div>
							<div className="px-3 py-2 break-all text-xs">
								{authStatus.authResults}
							</div>
						</div>
					)}

					{/*<div className="grid grid-cols-[160px_1fr] border-b">*/}
					{/*    <div className="bg-muted px-3 py-2 font-medium text-muted-foreground">*/}
					{/*        SPF*/}
					{/*    </div>*/}
					{/*    <div className="px-3 py-2">*/}
					{/*        <span className="text-green-600 font-semibold">PASS</span> with IP 209.85.220.69{" "}*/}
					{/*        <a href="#" className="text-blue-600 hover:underline">Learn more</a>*/}
					{/*    </div>*/}
					{/*</div>*/}

					{/*<div className="grid grid-cols-[160px_1fr] border-b">*/}
					{/*    <div className="bg-muted px-3 py-2 font-medium text-muted-foreground">*/}
					{/*        DKIM*/}
					{/*    </div>*/}
					{/*    <div className="px-3 py-2">*/}
					{/*        <span className="text-green-600 font-semibold">'PASS'</span> with domain google.com{" "}*/}
					{/*        <a href="#" className="text-blue-600 hover:underline">Learn more</a>*/}
					{/*    </div>*/}
					{/*</div>*/}

					{/*<div className="grid grid-cols-[160px_1fr]">*/}
					{/*    <div className="bg-muted px-3 py-2 font-medium text-muted-foreground">*/}
					{/*        DMARC*/}
					{/*    </div>*/}
					{/*    <div className="px-3 py-2">*/}
					{/*        <span className="text-green-600 font-semibold">'PASS'</span>{" "}*/}
					{/*        <a href="#" className="text-blue-600 hover:underline">Learn more</a>*/}
					{/*    </div>*/}
					{/*</div>*/}
				</div>

				{/* Action Buttons */}
				{/*<div className="flex justify-end gap-2 mt-4">*/}
				{/*<button*/}
				{/*    className="text-blue-600 hover:underline text-sm"*/}
				{/*    onClick={() => console.log("download original")}*/}
				{/*>*/}
				{/*    Download original*/}
				{/*</button>*/}
				{/*<button*/}
				{/*    className="text-blue-600 hover:underline text-sm"*/}
				{/*    onClick={() => navigator.clipboard.writeText("original message headers")}*/}
				{/*>*/}
				{/*    Copy to clipboard*/}
				{/*</button>*/}
				{/*</div>*/}

				<div
					className="
    bg-neutral-50 dark:bg-neutral-900
    border border-neutral-200 dark:border-neutral-800
    rounded-md mt-4 p-4 text-sm font-mono
    whitespace-pre-wrap break-words overflow-x-auto
    shadow-sm text-neutral-800 dark:text-neutral-200
  "
				>
					{emailString || "Loading raw message..."}
				</div>
			</Modal>

			<div className={"grid grid-cols-12"}>
				<div className={"col-span-12"}>
					{threadIndex === 0 && (
						<div className={"flex gap-3 items-center"}>
							<div className="text-xl font-base">
								{message.subject || "No Subject"}
							</div>
							<MailUnsubscriber
								mailSubscription={mailSubscription}
								message={message}
							/>
						</div>
					)}
				</div>

				<div className={"md:col-span-6 col-span-12 flex flex-col"}>
					<div className={"mt-4 flex gap-1 items-center"}>
						<div className={"text-sm font-semibold capitalize"}>
							{getMessageName(message, "from") ??
								slugify(String(getMessageAddress(message, "from")), {
									separator: " ",
								})}
						</div>
						<div
							className={"text-xs"}
						>{`<${getMessageAddress(message, "from") ?? getMessageName(message, "from")}>`}</div>
					</div>
					<div className={"flex gap-1 items-center"}>
						<div className={"text-xs break-all"}>
							to {formatAddressList(message, "to") || "undisclosed recipients"}
						</div>
					</div>
					{formatAddressList(message, "cc") && (
						<div className={"flex gap-1 items-center"}>
							<div className={"text-xs break-all"}>
								cc {formatAddressList(message, "cc")}
							</div>
						</div>
					)}
					{authStatus && (
						<div className="mt-1 flex gap-1 text-[11px] uppercase">
							{(["spf", "dkim", "dmarc"] as const).map((kind) => (
								<span
									key={kind}
									className={`rounded border px-1.5 py-0.5 ${authClass(authStatus[kind])}`}
								>
									{kind} {authStatus[kind]}
								</span>
							))}
						</div>
					)}
				</div>

				{/*<div className={"col-span-6 my-1"}>*/}
				{/*    <div className={"text-xs"}>{formatted}</div>*/}
				{/*</div>*/}

				<div
					className={
						"md:col-span-6 col-span-12 my-1 flex md:justify-end justify-between items-center gap-2 "
					}
				>
					<div className={"text-xs "} suppressHydrationWarning>
						{formatted}
					</div>
					<div className={"flex gap-1 justify-end items-center"}>
						<ActionIcon
							variant={"transparent"}
							disabled={isMutating}
							onClick={() => markThreadReadState(!isRead)}
							title={isRead ? "Mark as unread" : "Mark as read"}
						>
							{isRead ? <Mail size={18} /> : <MailOpen size={18} />}
						</ActionIcon>
						<ActionIcon
							variant={"transparent"}
							disabled={isMutating}
							onClick={() => moveThreadOut("spam")}
							title="Mark as spam"
						>
							<Ban size={18} />
						</ActionIcon>
						<ActionIcon
							variant={"transparent"}
							disabled={isMutating}
							onClick={() => moveThreadOut("trash")}
							title="Delete"
						>
							<Trash2 size={18} />
						</ActionIcon>
						<ActionIcon
							variant={"transparent"}
							disabled={isOpeningEditor}
							title="Reply"
							onClick={() => {
								if (showEditor) setShowEditor(false);
								else void openEditor("reply");
							}}
						>
							<Reply size={18} />
						</ActionIcon>

						<div className={"cursor-pointer"}>
							<Menu shadow="md" width={175} position={"left-start"}>
								<Menu.Target>
									<EllipsisVertical size={18} />
								</Menu.Target>

								<Menu.Dropdown>
									<Menu.Item
										leftSection={
											isRead ? <Mail size={14} /> : <MailOpen size={14} />
										}
										onClick={() => markThreadReadState(!isRead)}
										disabled={isMutating}
									>
										{isRead ? "Mark as unread" : "Mark as read"}
									</Menu.Item>
									<Menu.Item
										leftSection={<Ban size={14} />}
										onClick={() => moveThreadOut("spam")}
										disabled={isMutating}
									>
										Mark as spam
									</Menu.Item>
									<Menu.Item
										leftSection={<Trash2 size={14} />}
										onClick={() => moveThreadOut("trash")}
										disabled={isMutating}
										color="red"
									>
										Delete
									</Menu.Item>
									<Menu.Divider />
									<Menu.Item
										leftSection={<Reply size={14} />}
										onClick={() => void openEditor("reply")}
									>
										Reply
									</Menu.Item>
									<Menu.Item
										leftSection={<Forward size={14} />}
										onClick={() => void openEditor("forward")}
									>
										Forward
									</Menu.Item>
									<Menu.Divider />

									<Menu.Item
										leftSection={<Download size={14} />}
										onClick={downloadEml}
									>
										Download
									</Menu.Item>
									<Menu.Item leftSection={<Code size={14} />} onClick={open}>
										Show Original
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						</div>
					</div>
				</div>
			</div>

			{children}

			{attachments?.length > 0 && (
				<div className="border-t border-dotted py-4">
					<div className="font-semibold mb-4">
						{attachments.length} attachments
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
						{attachments.map((attachment) => (
							<EditorAttachmentItem
								key={attachment.id}
								attachment={attachment}
								signedUrl={attachmentUrls?.[String(attachment.id)]}
								publicConfig={publicConfig}
							/>
						))}
					</div>
				</div>
			)}

			{threadIndex === numberOfMessages - 1 && !showEditor && (
				<div className={"flex gap-6"}>
					<Button
						onClick={() => void openEditor("reply")}
						loading={isOpeningEditor && showEditorMode === "reply"}
						leftSection={<Reply />}
						variant={"outline"}
						radius={"xl"}
					>
						Reply
					</Button>
					<Button
						onClick={() => void openEditor("forward")}
						loading={isOpeningEditor && showEditorMode === "forward"}
						rightSection={<Forward />}
						variant={"outline"}
						radius={"xl"}
					>
						Forward
					</Button>
				</div>
			)}

			{showEditor && (
				<div>
					<EmailEditor
						// Remount when switching reply <-> forward so recipients,
						// subject and mode are rebuilt for the new mode.
						key={`${showEditorMode}:${initialDraft?.id ?? "new"}`}
						initialDraft={initialDraft}
						originalAttachments={attachments
							.filter((a) => !a.isInline)
							.map((a) => ({
								id: String(a.id),
								filenameOriginal: a.filenameOriginal,
								sizeBytes: a.sizeBytes,
							}))}
						sentMailboxId={sentMailboxId ?? ""}
						ref={editorRef}
						publicConfig={publicConfig}
						message={message}
						onReady={(el) => {
							scrollToEditor(el, { offsetTop: 96, minBottomGap: 64 });
							requestAnimationFrame(() => editorRef.current?.focus());
						}}
						handleClose={() => setShowEditor(false)}
						showEditorMode={showEditorMode}
						signatureHtml={signatureHtml}
					/>
				</div>
			)}
		</>
	);
}

export default EmailRenderer;
