"use client";

import { ActionIcon } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { PublicConfig } from "@schema";
import { MailPlus, Minus, PencilLine, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import type React from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	OPEN_DRAFT_EVENT,
	type OpenDraftDetail,
} from "@/components/mailbox/default/draft-events";
import type {
	EmailEditorHandle,
	InitialDraft,
} from "@/components/mailbox/default/editor/email-editor";
import { Button } from "@/components/ui/button";
import {
	type FetchIdentityMailboxListResult,
	fetchIdentityMailboxList,
	fetchMailbox,
} from "@/lib/actions/mailbox";

// ComposeMail is rendered in the mail layout (every mail page), but the TipTap
// editor is only needed once the user clicks "Compose": load it on demand and
// warm the chunk on hover/focus of the button.
const loadEmailEditor = () =>
	import("@/components/mailbox/default/editor/email-editor");
const EmailEditor = dynamic(loadEmailEditor, {
	ssr: false,
	loading: () => (
		<div className="px-4 py-10 text-sm text-muted-foreground">
			Loading editor…
		</div>
	),
});
const preloadEmailEditor = () => {
	void loadEmailEditor();
};

function Portal({ children }: { children: React.ReactNode }) {
	const elRef = useRef<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState(false);

	if (!elRef.current) elRef.current = document.createElement("div");

	useEffect(() => {
		const el = elRef.current!;
		document.body.appendChild(el);
		setMounted(true);
		return () => {
			document.body.removeChild(el);
		};
	}, []);

	return mounted ? createPortal(children, elRef.current!) : null;
}

export default function ComposeMail({
	publicConfig,
	identityMailboxes: initialIdentityMailboxes,
}: {
	publicConfig: PublicConfig;
	identityMailboxes?: FetchIdentityMailboxListResult;
}) {
	const [open, setOpen] = useState(false);
	const [appeared, setAppeared] = useState(false);
	const [minimized, setMinimized] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [sentMailboxId, setSentMailboxId] = useState<string>();
	const [signatureHtml, setSignatureHtml] = useState<string>("");
	const [senderOptions, setSenderOptions] = useState<
		{ value: string; label: string; email: string; signatureHtml: string }[]
	>([]);
	const [showEditorMode] = useState<string>("compose");
	const [initialDraft, setInitialDraft] = useState<InitialDraft>(null);
	const [editorKey, setEditorKey] = useState(0);
	const preferredMailboxRef = useRef<string | null>(null);
	const editorRef = useRef<EmailEditorHandle>(null);
	const params = useParams();
	const isMobile = useMediaQuery("(max-width: 768px)");

	const findSentMailbox = (entry: FetchIdentityMailboxListResult[number]) => {
		return (
			entry.mailboxes.find((mailbox) => mailbox.kind === "sent") ??
			entry.mailboxes.find((mailbox) => mailbox.slug === "sent") ??
			entry.mailboxes.find((mailbox) => mailbox.slug === "gesendet") ??
			entry.mailboxes.find((mailbox) =>
				mailbox.name?.toLowerCase().includes("sent"),
			) ??
			entry.mailboxes.find((mailbox) =>
				mailbox.name?.toLowerCase().includes("gesendet"),
			)
		);
	};

	const loadSenders = async () => {
		const entries = initialIdentityMailboxes?.length
			? initialIdentityMailboxes
			: await fetchIdentityMailboxList();
		const options = entries
			.map((entry) => {
				const sentMailbox = findSentMailbox(entry);
				if (!sentMailbox) return null;
				const email = String(entry.identity.value ?? "");
				return {
					value: String(sentMailbox.id),
					label: email,
					email,
					signatureHtml: entry.identity.signatureHtml ?? "",
				};
			})
			.filter(Boolean) as {
			value: string;
			label: string;
			email: string;
			signatureHtml: string;
		}[];

		setSenderOptions(options);

		// A restored draft keeps the sender it was written from.
		const preferred = preferredMailboxRef.current;
		if (preferred && options.some((o) => o.value === preferred)) {
			setSentMailboxId(preferred);
			setSignatureHtml(
				options.find((o) => o.value === preferred)?.signatureHtml ?? "",
			);
			return;
		}

		const activeIdentityPublicId = params.identityPublicId
			? String(params.identityPublicId)
			: null;
		const activeEntry = activeIdentityPublicId
			? entries.find(
					(entry) => entry.identity.publicId === activeIdentityPublicId,
				)
			: null;
		const activeSentMailbox = activeEntry ? findSentMailbox(activeEntry) : null;

		if (activeSentMailbox) {
			setSentMailboxId(String(activeSentMailbox.id));
			setSignatureHtml(activeEntry?.identity.signatureHtml ?? "");
			return;
		}

		if (options[0]) {
			setSentMailboxId(options[0].value);
			setSignatureHtml(options[0].signatureHtml);
			return;
		}

		if (activeIdentityPublicId) {
			const { activeMailbox, identity } = await fetchMailbox(
				activeIdentityPublicId,
				"sent",
			);
			if (activeMailbox) setSentMailboxId(String(activeMailbox.id));
			setSignatureHtml(identity?.signatureHtml ?? "");
		}
	};

	useEffect(() => {
		if (!open) return;
		loadSenders();

		const t = setTimeout(() => setAppeared(true), 16);
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		const onEsc = (e: KeyboardEvent) => e.key === "Escape" && handleClose();
		window.addEventListener("keydown", onEsc);

		return () => {
			clearTimeout(t);
			document.body.style.overflow = prev;
			window.removeEventListener("keydown", onEsc);
		};
	}, [open]);

	// Effect event: always sees the latest state without re-subscribing the
	// window listener on every render.
	const onOpenDraft = useEffectEvent((event: Event) => {
		const detail = (event as CustomEvent<OpenDraftDetail>).detail;
		if (!detail) return;
		preferredMailboxRef.current = detail.mailboxId;
		setInitialDraft({ id: detail.id, payload: detail.payload });
		setEditorKey((k) => k + 1);
		setMinimized(false);
		if (open) {
			void loadSenders();
		} else {
			setSentMailboxId(undefined);
			setOpen(true);
		}
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: effect events must not be dependencies
	useEffect(() => {
		const listener = (event: Event) => onOpenDraft(event);
		window.addEventListener(OPEN_DRAFT_EVENT, listener);
		return () => window.removeEventListener(OPEN_DRAFT_EVENT, listener);
	}, []);

	const handleOpen = () => {
		preferredMailboxRef.current = null;
		setInitialDraft(null);
		setEditorKey((k) => k + 1);
		setOpen(true);
		setMinimized(false);
		setExpanded(false);
		setSentMailboxId(undefined);
	};

	const handleClose = () => {
		setOpen(false);
		setAppeared(false);
	};

	return (
		<>
			{isMobile ? (
				<ActionIcon
					onClick={handleOpen}
					onPointerEnter={preloadEmailEditor}
					onFocus={preloadEmailEditor}
					aria-label="Compose"
				>
					<PencilLine size={16} />
				</ActionIcon>
			) : (
				<Button
					size="lg"
					onClick={handleOpen}
					onPointerEnter={preloadEmailEditor}
					onFocus={preloadEmailEditor}
				>
					<MailPlus className="h-5 w-5" />
					Compose
				</Button>
			)}

			{!open ? null : (
				<Portal>
					<div
						className={[
							"fixed inset-0",
							appeared ? "opacity-100" : "opacity-0",
							"transition-opacity",
						].join(" ")}
					/>

					{isMobile ? (
						<div
							role="dialog"
							aria-modal="true"
							className={[
								"fixed inset-0 z-[1000] bg-background text-foreground",
								"flex flex-col",
								"motion-safe:transition-transform motion-safe:duration-200",
								appeared ? "translate-y-0" : "translate-y-3",
							].join(" ")}
							onClick={(e) => e.stopPropagation()}
						>
							<div className="sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3">
								<div className="text-sm font-medium">New Message</div>
								<button
									type="button"
									onClick={handleClose}
									aria-label="Close"
									title="Close"
									className="p-2 rounded-md hover:bg-muted transition-colors"
								>
									<X className="h-5 w-5" />
								</button>
							</div>

							<div className="flex-1 min-h-0 overflow-auto px-0 pb-[env(safe-area-inset-bottom)]">
								<EmailEditor
									key={editorKey}
									initialDraft={initialDraft}
									sentMailboxId={sentMailboxId ?? ""}
									senderOptions={senderOptions}
									onSentMailboxChange={(value) => {
										setSentMailboxId(value);
										setSignatureHtml(
											senderOptions.find((option) => option.value === value)
												?.signatureHtml ?? "",
										);
									}}
									ref={editorRef}
									publicConfig={publicConfig}
									message={null}
									onReady={() =>
										requestAnimationFrame(() => editorRef.current?.focus())
									}
									showEditorMode={showEditorMode}
									signatureHtml={signatureHtml}
									handleClose={handleClose}
								/>
							</div>
						</div>
					) : (
						<div
							role="dialog"
							aria-modal="true"
							className={[
								"fixed z-[1000] bg-background border shadow-xl rounded-lg overflow-hidden",
								"right-12 bottom-4",
								// expanded ? "w-[720px] h-[70vh]" : "w-[520px] h-auto",
								expanded ? "w-[720px] h-[70vh]" : "w-[520px] h-auto",
								"transition-[width,height] duration-200 ease-out",
								"motion-safe:transition-opacity motion-safe:duration-200 motion-safe:ease-out motion-safe:transition-transform",
								appeared
									? "opacity-100 translate-y-0 scale-100"
									: "opacity-0 translate-y-3 scale-[0.98]",
								"hover:shadow-2xl",
							].join(" ")}
							onClick={(e) => e.stopPropagation()}
						>
							<div className="flex items-center justify-between border-b px-4 py-2">
								{/*<div className="text-sm font-medium">New Message</div>*/}
								<div className="flex items-center gap-2">
									<IconBtn
										label={minimized ? "Restore" : "Minimize"}
										onClick={() => setMinimized((v) => !v)}
									>
										<Minus className="h-4 w-4" />
									</IconBtn>
									<IconBtn label="Close" onClick={handleClose}>
										<X className="h-4 w-4" />
									</IconBtn>
								</div>
							</div>

							<div
								className={[
									"px-0 pb-0 grid",
									minimized
										? "grid-rows-[0fr] opacity-0"
										: "grid-rows-[1fr] opacity-100",
									"transition-[grid-template-rows,opacity] duration-200 ease-out",
									"overflow-hidden",
									expanded ? "max-h-[calc(70vh-48px)]" : "max-h-none",
								].join(" ")}
							>
								<div className="min-h-0">
									<EmailEditor
										key={editorKey}
										initialDraft={initialDraft}
										sentMailboxId={sentMailboxId ?? ""}
										senderOptions={senderOptions}
										onSentMailboxChange={(value) => {
											setSentMailboxId(value);
											setSignatureHtml(
												senderOptions.find((option) => option.value === value)
													?.signatureHtml ?? "",
											);
										}}
										ref={editorRef}
										publicConfig={publicConfig}
										message={null}
										showEditorMode={showEditorMode}
										signatureHtml={signatureHtml}
										handleClose={handleClose}
									/>
								</div>
							</div>
						</div>
					)}
				</Portal>
			)}
		</>
	);
}

function IconBtn({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick?: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className="p-2 rounded-md hover:bg-muted transition-colors"
		>
			{children}
		</button>
	);
}
