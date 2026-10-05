"use client";

import { getMessageAddress, getMessageName } from "@common/mail-client";
import type {
	MailSubscriptionEntity,
	MessageAttachmentEntity,
	MessageEntity,
} from "@db";
import { ActionIcon, Button, Menu, Modal } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { AddressObjectJSON, PublicConfig } from "@schema";
import slugify from "@sindresorhus/slugify";
import {
	Ban,
	Code,
	Download,
	EllipsisVertical,
	Forward,
	Mail,
	Reply,
	Trash2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import ThreadLabelHoverButtons from "@/components/dashboard/labels/thread-label-hover-buttons";
import EditorAttachmentItem from "@/components/mailbox/default/editor/editor-attachment-item";
import EmailViewer from "@/components/mailbox/default/email-viewer";
import MailUnsubscriber from "@/components/mailbox/default/mail-unsubscriber";
import {
	formatDateTime,
	useIsClient,
} from "@/components/mailbox/default/thread-list-utils";
import { CLOSE_THREAD_EVENT } from "@/components/mailbox/default/thread-navigation-store";
import { useOptionalI18n } from "@/components/providers/dictionary-provider";
import type {
	FetchLabelsResult,
	FetchMailboxThreadLabelsResult,
} from "@/lib/actions/labels";
import {
	deleteForever,
	type FetchIdentityMailboxListResult,
	markAsUnread,
	moveToSpam,
	moveToTrash,
} from "@/lib/actions/mailbox";
import { getRawMessageDownloadUrl } from "@/lib/actions/uploads-actions";

const InspectorBar = dynamic(
	() => import("@/components/dashboard/inspector/inspector-bar"),
	{
		ssr: true,
		loading: () => <InspectorLoading />,
	},
);

// The composer (TipTap, Mantine RTE) is only needed once the user replies.
const MailComposer = dynamic(
	() => import("@/components/mailbox/default/composer/mail-composer"),
	{
		ssr: false,
		loading: () => <InspectorLoading />,
	},
);

function InspectorLoading() {
	const i18n = useOptionalI18n();
	return (
		<div className="my-5 rounded-xl border bg-card p-6 text-sm text-muted-foreground">
			{i18n?.dict?.mailbox?.loadingEllipsis ?? "Loading…"}
		</div>
	);
}

export type MessageAttachmentWithUrl = MessageAttachmentEntity & {
	signedUrl: string;
};

type ComposerMode = "reply" | "forward";

type LooseHeaders = Record<string, { text?: string } | string | undefined>;

function headerText(message: MessageEntity, key: string): string {
	const value = (message.headersJson as LooseHeaders | null)?.[key];
	if (!value) return "";
	return typeof value === "string" ? value : (value.text ?? "");
}

/** "Name <a@x>, b@y" for every address of a To/Cc field. */
function formatAddressList(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	const list = (value as AddressObjectJSON).value;
	if (!Array.isArray(list)) return (value as AddressObjectJSON).text ?? "";
	return list
		.map((entry) => {
			const address = entry?.address ?? "";
			const name = entry?.name?.trim();
			if (name && address) return `${name} <${address}>`;
			return address || name || "";
		})
		.filter(Boolean)
		.join(", ");
}

/** Formats in the viewer's timezone, on the client only (no SSR mismatch). */
function LocalDateTime({
	value,
	className,
}: {
	value: Date | string | null | undefined;
	className?: string;
}) {
	const isClient = useIsClient();
	const i18n = useOptionalI18n();
	const date = value ? new Date(value) : null;
	const valid = date !== null && !Number.isNaN(date.getTime());

	return (
		<time
			dateTime={valid ? date.toISOString() : undefined}
			className={className}
			suppressHydrationWarning
		>
			{isClient && valid ? formatDateTime(date, i18n?.dict?.locale) : ""}
		</time>
	);
}

function getScrollParent(el: HTMLElement): HTMLElement {
	let parent: HTMLElement | null = el.parentElement;

	while (parent) {
		const style = getComputedStyle(parent);
		const overflowY = style.overflowY || style.overflow;

		const canScrollY =
			(overflowY === "auto" || overflowY === "scroll") &&
			parent.scrollHeight > parent.clientHeight;

		if (canScrollY) {
			return parent;
		}

		parent = parent.parentElement;
	}

	return (document.scrollingElement || document.documentElement) as HTMLElement;
}

export function scrollToEditor(
	el: HTMLElement,
	{
		offsetTop = 96,
		minBottomGap = 48,
	}: {
		offsetTop?: number;
		minBottomGap?: number;
	} = {},
) {
	const container = getScrollParent(el);

	const isWindow = container === (document.scrollingElement as HTMLElement);

	const containerRect = isWindow
		? ({
				top: 10,
				height: window.innerHeight,
			} as DOMRect)
		: container.getBoundingClientRect();

	const editorRect = el.getBoundingClientRect();

	const currentTop = isWindow ? window.scrollY : container.scrollTop;

	const targetTop =
		currentTop + (editorRect.top - containerRect.top) - offsetTop;

	const doScroll = (top: number) => {
		if (isWindow) {
			window.scrollTo({
				top,
				behavior: "smooth",
			});
		} else {
			container.scrollTo({
				top,
				behavior: "smooth",
			});
		}
	};

	doScroll(targetTop);

	setTimeout(() => {
		const editorRectAfterScroll = el.getBoundingClientRect();

		const viewHeight = isWindow ? window.innerHeight : container.clientHeight;

		const bottomGap = viewHeight - editorRectAfterScroll.bottom;

		if (bottomGap < minBottomGap) {
			const delta = minBottomGap - bottomGap;

			if (isWindow) {
				window.scrollBy({
					top: delta,
					behavior: "smooth",
				});
			} else {
				container.scrollBy({
					top: delta,
					behavior: "smooth",
				});
			}
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
	activeMailboxKind,
	mailSubscription,
	identityMailboxes,
	allLabels,
	labelsByThreadId,
	backHref,
	cidUrls,
}: {
	threadIndex: number;
	numberOfMessages: number;
	message: MessageEntity;
	attachments: MessageAttachmentWithUrl[];
	publicConfig: PublicConfig;
	threadId: string;
	markSmtp: boolean;
	activeMailboxId: string;
	activeMailboxKind: string;
	mailSubscription: MailSubscriptionEntity | null;
	identityMailboxes: FetchIdentityMailboxListResult;
	allLabels: FetchLabelsResult;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	backHref: string;
	cidUrls?: Record<string, string>;
}) {
	const i18n = useOptionalI18n();
	const dict = i18n?.dict;
	const format = i18n?.format;
	const params = useParams();
	const router = useRouter();
	const composerRef = useRef<HTMLDivElement>(null);
	// The received date when known, not when Kurrier stored the message.
	const messageDate = message.date ?? message.createdAt;

	const [showEditor, setShowEditor] = useState(false);

	const [showEditorMode, setShowEditorMode] = useState<ComposerMode>("reply");

	useEffect(() => {
		if (!showEditor) return;

		requestAnimationFrame(() => {
			const el = composerRef.current;

			if (!el) return;

			scrollToEditor(el, {
				offsetTop: 96,
				minBottomGap: 64,
			});
		});
	}, [showEditor]);

	const downloadEml = async () => {
		try {
			const { url } = await getRawMessageDownloadUrl(message.id);

			if (url) {
				window.open(url, "_blank", "noopener,noreferrer");
			}
		} catch (error) {
			toast.error(dict?.mailbox?.actionFailed ?? "Action failed", {
				description: error instanceof Error ? error.message : undefined,
				position: "bottom-left",
			});
		}
	};

	const [opened, { open, close }] = useDisclosure(false);

	const [emailString, setEmailString] = useState<string | null>(null);

	useEffect(() => {
		if (!opened) return;

		let cancelled = false;
		getRawMessageDownloadUrl(message.id)
			.then(async ({ url }) => {
				if (!url) return;
				const raw = await (await fetch(url)).text();
				if (!cancelled) setEmailString(raw.slice(0, 10000));
			})
			.catch(() => {
				if (!cancelled) setEmailString(null);
			});
		return () => {
			cancelled = true;
		};
	}, [opened, message.id]);

	const activeIdentityPublicId = useMemo(() => {
		const routeIdentityPublicId = String(params.identityPublicId ?? "");

		const exists = identityMailboxes.some(
			(item) => item.identity.publicId === routeIdentityPublicId,
		);

		if (exists) {
			return routeIdentityPublicId;
		}

		return identityMailboxes[0]?.identity.publicId;
	}, [params.identityPublicId, identityMailboxes]);

	const openComposer = (mode: ComposerMode) => {
		setShowEditorMode(mode);
		setShowEditor(true);
	};

	const closeComposer = () => setShowEditor(false);

	const [isActionPending, startAction] = useTransition();

	// Thread-level actions from a message: run, then go back to the list
	// (the thread left this view, or should stay unread).
	const runThreadAction = (
		action: () => Promise<unknown>,
		successMessage: string,
	) => {
		startAction(async () => {
			try {
				await action();
				toast.success(successMessage, { position: "bottom-left" });
				window.dispatchEvent(new CustomEvent(CLOSE_THREAD_EVENT));
				router.replace(backHref);
				router.refresh();
			} catch (error) {
				toast.error(dict?.mailbox?.actionFailed ?? "Action failed", {
					description: error instanceof Error ? error.message : undefined,
					position: "bottom-left",
				});
			}
		});
	};

	const markThreadUnread = () =>
		runThreadAction(
			() => markAsUnread(threadId, activeMailboxId, markSmtp, true),
			dict?.mailbox?.markedAsUnread ?? "Marked as unread",
		);

	const moveThreadToSpam = () =>
		runThreadAction(
			() => moveToSpam(threadId, activeMailboxId, markSmtp, true),
			dict?.mailbox?.movedToSpam ?? "Moved to Spam",
		);

	const deleteThread = () => {
		if (activeMailboxKind === "trash") {
			runThreadAction(
				() => deleteForever(threadId, activeMailboxId, markSmtp, true),
				dict?.mailbox?.threadDeletedForever ?? "Thread deleted forever",
			);
			return;
		}
		runThreadAction(
			() => moveToTrash(threadId, activeMailboxId, markSmtp, true),
			dict?.mailbox?.movedToTrash ?? "Messages moved to Trash",
		);
	};

	const fromAddress = getMessageAddress(message, "from");
	const fromName = getMessageName(message, "from");
	const toList = formatAddressList(message.to);
	const ccList = formatAddressList(message.cc);
	const deleteLabel =
		activeMailboxKind === "trash"
			? (dict?.mailbox?.deleteForever ?? "Delete forever")
			: (dict?.mailbox?.delete ?? "Delete");

	return (
		<>
			<Modal
				opened={opened}
				onClose={close}
				title={dict?.mailbox?.originalMessage ?? "Original message"}
				size="xl"
			>
				<div className="overflow-hidden rounded-md border text-sm">
					<div className="grid grid-cols-1 border-b sm:grid-cols-[160px_minmax(0,1fr)]">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							{dict?.mailbox?.messageId ?? "Message ID"}
						</div>

						<div className="break-all px-3 py-2 text-green-700">
							{message.messageId}
						</div>
					</div>

					<div className="grid grid-cols-1 border-b sm:grid-cols-[160px_minmax(0,1fr)]">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							{dict?.mailbox?.createdOn ?? "Created on"}
						</div>

						<div className="px-3 py-2">
							<LocalDateTime value={messageDate} />
						</div>
					</div>

					<div className="grid grid-cols-1 border-b sm:grid-cols-[160px_minmax(0,1fr)]">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							{dict?.mailbox?.from ?? "From"}
						</div>

						<div className="min-w-0 break-words px-3 py-2">
							{headerText(message, "from")}
						</div>
					</div>

					<div className="grid grid-cols-1 border-b sm:grid-cols-[160px_minmax(0,1fr)]">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							{dict?.mailbox?.to ?? "To"}
						</div>

						<div className="min-w-0 break-words px-3 py-2">
							{headerText(message, "to")}
						</div>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-[160px_minmax(0,1fr)]">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							{dict?.mailbox?.subject ?? "Subject"}
						</div>

						<div className="min-w-0 break-words px-3 py-2">
							{headerText(message, "subject")}
						</div>
					</div>
				</div>

				<div
					className="
						mt-4 overflow-x-auto whitespace-pre-wrap break-words
						rounded-md border border-neutral-200 bg-neutral-50
						p-4 font-mono text-sm text-neutral-800 shadow-sm
						dark:border-neutral-800 dark:bg-neutral-900
						dark:text-neutral-200
					"
				>
					{emailString ||
						(dict?.mailbox?.loadingRawMessage ?? "Loading raw message...")}
				</div>
			</Modal>

			<div className="min-w-0">
				<div className="min-w-0">
					{threadIndex === 0 && (
						<div className="flex min-w-0 flex-wrap items-start gap-2 sm:gap-3">
							<h1 className="min-w-0 flex-1 break-words text-pretty text-lg font-semibold leading-7 sm:text-xl sm:leading-8">
								{message.subject ||
									(dict?.mailbox?.noSubjectTitle ?? "No Subject")}
							</h1>

							<MailUnsubscriber
								mailSubscription={mailSubscription}
								message={message}
							/>
						</div>
					)}
				</div>

				<div className="mt-4 flex min-w-0 flex-col gap-3 sm:mt-5 md:flex-row md:items-end md:justify-between">
					<div className="min-w-0">
						<div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
							<div className="min-w-0 break-words text-sm font-semibold capitalize">
								{fromName ??
									slugify(String(fromAddress), {
										separator: " ",
									})}
							</div>

							<div className="min-w-0 break-all text-xs text-muted-foreground sm:truncate">
								{`<${fromAddress ?? fromName}>`}
							</div>
						</div>

						{toList && (
							<div className="mt-1 min-w-0 break-words text-xs text-muted-foreground">
								{dict?.mailbox?.toLower ?? "to"} {toList}
							</div>
						)}

						{ccList && (
							<div className="mt-0.5 min-w-0 break-words text-xs text-muted-foreground">
								{dict?.mailbox?.ccLower ?? "cc"} {ccList}
							</div>
						)}
					</div>

					<div className="flex min-w-0 items-center justify-between gap-3 border-t pt-2 md:shrink-0 md:border-0 md:pt-0">
						<LocalDateTime
							value={messageDate}
							className="min-w-0 text-xs text-muted-foreground sm:whitespace-nowrap"
						/>

						<div className="flex shrink-0 items-center justify-end gap-1">
							<ThreadLabelHoverButtons
								mailboxThreadItem={{
									threadId,
									mailboxId: activeMailboxId,
								}}
								allLabels={allLabels}
								labelsByThreadId={labelsByThreadId}
							/>

							<ActionIcon
								variant="transparent"
								size={44}
								aria-label={dict?.mailbox?.reply ?? "Reply"}
								title={dict?.mailbox?.reply ?? "Reply"}
								onClick={() => openComposer("reply")}
							>
								<Reply size={18} />
							</ActionIcon>

							<ActionIcon
								variant="transparent"
								size={44}
								aria-label={deleteLabel}
								title={deleteLabel}
								disabled={isActionPending}
								onClick={deleteThread}
							>
								<Trash2 size={18} />
							</ActionIcon>

							<Menu shadow="md" width={200} position="bottom-end">
								<Menu.Target>
									<ActionIcon
										variant="transparent"
										size={44}
										aria-label={dict?.mailbox?.actions ?? "More actions"}
									>
										<EllipsisVertical size={18} />
									</ActionIcon>
								</Menu.Target>

								<Menu.Dropdown>
									<Menu.Item
										leftSection={<Reply size={14} />}
										onClick={() => openComposer("reply")}
									>
										{dict?.mailbox?.reply ?? "Reply"}
									</Menu.Item>

									<Menu.Item
										leftSection={<Forward size={14} />}
										onClick={() => openComposer("forward")}
									>
										{dict?.mailbox?.forward ?? "Forward"}
									</Menu.Item>

									<Menu.Divider />

									<Menu.Item
										leftSection={<Mail size={14} />}
										disabled={isActionPending}
										onClick={markThreadUnread}
									>
										{dict?.mailbox?.markAsUnread ?? "Mark as unread"}
									</Menu.Item>

									{activeMailboxKind !== "spam" && (
										<Menu.Item
											leftSection={<Ban size={14} />}
											disabled={isActionPending}
											onClick={moveThreadToSpam}
										>
											{dict?.mailbox?.markAsSpam ?? "Mark as spam"}
										</Menu.Item>
									)}

									<Menu.Item
										leftSection={<Trash2 size={14} />}
										color="red"
										disabled={isActionPending}
										onClick={deleteThread}
									>
										{deleteLabel}
									</Menu.Item>

									<Menu.Divider />

									<Menu.Item
										leftSection={<Download size={14} />}
										onClick={downloadEml}
									>
										{dict?.mailbox?.download ?? "Download"}
									</Menu.Item>

									<Menu.Item leftSection={<Code size={14} />} onClick={open}>
										{dict?.mailbox?.showOriginal ?? "Show Original"}
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						</div>
					</div>
				</div>
			</div>

			<InspectorBar message={message} onDownloadEml={downloadEml}>
				<EmailViewer message={message} cidUrls={cidUrls} />
			</InspectorBar>

			{attachments?.length > 0 && (
				<div className="border-t border-dotted py-4">
					<div className="mb-4 font-semibold">
						{format?.message(
							attachments.length,
							dict?.mailbox?.attachmentsCount ?? {
								other: "{count} attachments",
							},
						) ?? `${attachments.length} attachments`}
					</div>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
						{attachments.map((attachment) => (
							<EditorAttachmentItem
								key={attachment.id}
								attachment={attachment}
								publicConfig={publicConfig}
							/>
						))}
					</div>
				</div>
			)}

			{threadIndex === numberOfMessages - 1 && !showEditor && (
				<div className="flex flex-wrap gap-3 sm:gap-6">
					<Button
						onClick={() => openComposer("reply")}
						leftSection={<Reply />}
						variant="outline"
						radius="xl"
					>
						{dict?.mailbox?.reply ?? "Reply"}
					</Button>

					<Button
						onClick={() => openComposer("forward")}
						rightSection={<Forward />}
						variant="outline"
						radius="xl"
					>
						{dict?.mailbox?.forward ?? "Forward"}
					</Button>
				</div>
			)}

			{showEditor && (
				<div
					ref={composerRef}
					className="mt-4 overflow-hidden rounded-lg border"
				>
					<MailComposer
						key={`${message.id}-${showEditorMode}`}
						publicConfig={publicConfig}
						identityMailboxes={identityMailboxes}
						activeIdentityPublicId={activeIdentityPublicId}
						message={message}
						initialMode={showEditorMode}
						onClose={closeComposer}
					/>
				</div>
			)}
		</>
	);
}

export default EmailRenderer;
