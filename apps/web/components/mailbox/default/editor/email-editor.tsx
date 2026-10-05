"use client";
import type { MessageEntity } from "@db";
import { Button, Select, Textarea } from "@mantine/core";
import type { FormState, PublicConfig } from "@schema";
import Form from "next/form";
import React, {
	forwardRef,
	useActionState,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";
import { toast } from "sonner";
import {
	TextEditor,
	type TextEditorHandle,
} from "@/components/mailbox/default/editor/rich-text-editor";
import {
	DynamicContextProvider,
	useDynamicContext,
} from "@/hooks/use-dynamic-context";
import { fetchAiSettings } from "@/lib/actions/dashboard";
import {
	type DraftPayload,
	deleteDraft,
	generateAiReplySuggestion,
	saveDraft,
	sendMail,
} from "@/lib/actions/mailbox";

export type InitialDraft = { id: string; payload: DraftPayload } | null;

export type ForwardableAttachment = {
	id: string;
	filenameOriginal: string | null;
	sizeBytes: number | null;
};

const AUTOSAVE_DELAY_MS = 1500;

// DynamicContextProvider only reads initialState once; keep the pending flag
// of the send action in sync so the send button shows progress and cannot be
// clicked twice.
function SyncPendingState({ isPending }: { isPending: boolean }) {
	const { setState } = useDynamicContext<{ isPending: boolean }>();
	useEffect(() => {
		setState((prev) => ({ ...prev, isPending }));
	}, [isPending, setState]);
	return null;
}

export type EmailEditorHandle = {
	focus: () => void;
	getElement: () => HTMLElement | null;
};

type Props = {
	onReady?: (el: HTMLElement) => void;
	message: MessageEntity | null;
	publicConfig: PublicConfig;
	showEditorMode: string;
	signatureHtml?: string | null;
	sentMailboxId: string;
	senderOptions?: {
		value: string;
		label: string;
		email: string;
		signatureHtml?: string;
	}[];
	onSentMailboxChange?: (sentMailboxId: string) => void;
	handleClose: () => void;
	initialDraft?: InitialDraft;
	originalAttachments?: ForwardableAttachment[];
};

const EmailEditor = forwardRef<EmailEditorHandle, Props>(
	(
		{
			onReady,
			message,
			publicConfig,
			showEditorMode,
			signatureHtml,
			sentMailboxId,
			senderOptions = [],
			onSentMailboxChange,
			handleClose,
			initialDraft = null,
			originalAttachments = [],
		},
		ref,
	) => {
		const textEditorRef = useRef<TextEditorHandle>(null);
		const [aiInstruction, setAiInstruction] = React.useState("");
		const [isAiPending, setIsAiPending] = React.useState(false);
		const [aiEnabled, setAiEnabled] = React.useState(false);

		// Show the AI panel only when the user enabled the AI assistant.
		useEffect(() => {
			let cancelled = false;
			fetchAiSettings()
				.then((settings) => {
					if (!cancelled) setAiEnabled(Boolean(settings?.enabled));
				})
				.catch(() => {
					if (!cancelled) setAiEnabled(false);
				});
			return () => {
				cancelled = true;
			};
		}, []);

		// Parents pass handleClose inline; keep the latest one in a ref so the
		// send-result effect does not re-run (and re-toast) on every render.
		const handleCloseRef = useRef(handleClose);
		useEffect(() => {
			handleCloseRef.current = handleClose;
		}, [handleClose]);

		useImperativeHandle(
			ref,
			() => ({
				focus: () => textEditorRef.current?.focus("end"),
				getElement: () => textEditorRef.current?.getElement() ?? null,
			}),
			[],
		);

		// Only notify once: callers pass inline callbacks (scroll + focus) that
		// must not re-run on every parent render.
		const readyCalledRef = useRef(false);
		useEffect(() => {
			if (readyCalledRef.current) return;
			const el = textEditorRef.current?.getElement();
			if (el) {
				readyCalledRef.current = true;
				onReady?.(el);
			}
		}, [onReady]);

		const [formState, formAction, isPending] = useActionState<
			FormState,
			FormData
		>(sendMail, {});

		// ---- Draft autosave -------------------------------------------------
		// The form is snapshotted after every input and stored server side as a
		// "draft" row, so closing the editor (or Escape) never loses content.
		const formRef = useRef<HTMLFormElement>(null);
		const draftIdRef = useRef<string | null>(initialDraft?.id ?? null);
		const [draftId, setDraftId] = React.useState<string | null>(
			initialDraft?.id ?? null,
		);
		const lastSavedRef = useRef<string>(
			initialDraft ? JSON.stringify(initialDraft.payload) : "",
		);
		const snapshotRef = useRef<{
			payload: DraftPayload;
			mailbox: string;
		} | null>(null);
		const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
		const sendingRef = useRef(false);

		const takeSnapshot = () => {
			const form = formRef.current;
			if (!form) return;
			const fd = new FormData(form);
			const get = (k: string) => String(fd.get(k) ?? "");
			const payload: DraftPayload = {
				mode: (get("mode") ||
					(message ? "reply" : "compose")) as DraftPayload["mode"],
				to: get("to"),
				cc: get("cc"),
				bcc: get("bcc"),
				subject: get("subject"),
				bodyHtml: textEditorRef.current?.getHTML() ?? "",
				text: textEditorRef.current?.getText() ?? "",
				attachments: get("attachments"),
				originalMessageId: message?.id ? String(message.id) : undefined,
				threadUrl: message ? window.location.pathname : undefined,
			};
			snapshotRef.current = { payload, mailbox: get("sentMailboxId") };
		};

		const isEmptyPayload = (p: DraftPayload) => {
			let attachmentCount = 0;
			try {
				attachmentCount = JSON.parse(p.attachments || "[]").length;
			} catch {}
			return (
				!p.to &&
				!p.cc &&
				!p.bcc &&
				!p.text?.trim() &&
				attachmentCount === 0 &&
				// a pre-filled reply subject alone is not worth a draft
				(!!message || !p.subject?.trim())
			);
		};

		const persistDraft = (): boolean => {
			const snap = snapshotRef.current;
			if (!snap || sendingRef.current) return false;
			const json = JSON.stringify(snap.payload);
			if (json === lastSavedRef.current) return false;
			if (!draftIdRef.current && isEmptyPayload(snap.payload)) return false;
			lastSavedRef.current = json;
			// Serialize saves so a slow first save cannot create two rows.
			saveChainRef.current = saveChainRef.current.then(async () => {
				if (sendingRef.current) return;
				const res = await saveDraft({
					draftId: draftIdRef.current,
					sentMailboxId: snap.mailbox,
					payload: snap.payload,
				}).catch(() => null);
				if (res?.draftId) {
					draftIdRef.current = res.draftId;
					setDraftId(res.draftId);
				}
			});
			return true;
		};

		const scheduleSave = (event?: React.SyntheticEvent) => {
			// The AI instruction box is not part of the draft.
			const target = event?.target;
			if (target instanceof Element && target.closest("[data-no-autosave]"))
				return;
			// Hidden inputs (recipients, attachments) update after React renders.
			requestAnimationFrame(() => {
				takeSnapshot();
				if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
				saveTimerRef.current = setTimeout(persistDraft, AUTOSAVE_DELAY_MS);
			});
		};

		const escapeHtml = (value: string) =>
			value.replace(/[&<>"]/g, (char) => {
				const map: Record<string, string> = {
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
				};
				return map[char] || char;
			});

		const plainTextToHtml = (value: string) =>
			value
				.split(/\n{2,}/)
				.map((paragraph) => paragraph.trim())
				.filter(Boolean)
				.map(
					(paragraph) =>
						`<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`,
				)
				.join("");

		const getSuggestionText = (data: unknown) => {
			if (!data || typeof data !== "object" || !("suggestion" in data))
				return "";
			const suggestion = (data as { suggestion?: unknown }).suggestion;
			return typeof suggestion === "string" ? suggestion.trim() : "";
		};

		const handleGenerateAiSuggestion = async () => {
			setIsAiPending(true);
			try {
				// With an id the server loads the original body itself (the client
				// only has a reduced copy of the message without text/html).
				const originalMessageId = message?.id ? String(message.id) : undefined;
				const result = await generateAiReplySuggestion({
					mode: showEditorMode,
					userInstruction: aiInstruction,
					currentHtml: textEditorRef.current?.getHTML() || "",
					originalMessageId,
					originalSubject: message?.subject,
					originalText: originalMessageId
						? undefined
						: message?.text || message?.snippet,
					originalHtml: originalMessageId ? undefined : message?.html,
					originalFrom: message?.from,
				});

				if (!result.success) {
					toast.error("AI suggestion failed", {
						description:
							result.error || "The AI provider did not return a suggestion.",
					});
					return;
				}

				const suggestion = getSuggestionText(result.data);
				if (!suggestion) {
					toast.error("AI suggestion failed", {
						description: "The AI provider returned an empty suggestion.",
					});
					return;
				}

				const existingText = textEditorRef.current?.getText().trim() ?? "";
				if (
					existingText &&
					!window.confirm(
						"Replace the text you have already written with the AI draft?",
					)
				) {
					return;
				}
				textEditorRef.current?.setHTML(plainTextToHtml(suggestion));
				textEditorRef.current?.focus("end");
				scheduleSave();
				toast.success("AI suggestion inserted", {
					description: "Review and edit it before sending.",
				});
			} catch (error) {
				toast.error("AI suggestion failed", {
					description:
						error instanceof Error ? error.message : "Unexpected error.",
				});
			} finally {
				setIsAiPending(false);
			}
		};

		// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; the helpers only read refs
		useEffect(() => {
			// Safety net for changes that do not emit input events.
			const interval = setInterval(() => {
				takeSnapshot();
				persistDraft();
			}, 10_000);
			return () => {
				clearInterval(interval);
				if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
				// Flush the last snapshot when the editor is closed.
				const flushed = persistDraft();
				if (flushed || (draftIdRef.current && !sendingRef.current)) {
					toast.info("Draft saved", { position: "bottom-left" });
				}
			};
		}, []);

		const discardDraft = async () => {
			sendingRef.current = true;
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			await saveChainRef.current;
			if (draftIdRef.current) await deleteDraft(draftIdRef.current);
			draftIdRef.current = null;
			handleCloseRef.current();
			toast.success("Draft discarded", { position: "bottom-left" });
		};

		useEffect(() => {
			if (formState.error) {
				sendingRef.current = false;
				toast.error("Error", {
					description: formState.error,
				});
			} else if (formState.success) {
				// The server deletes the submitted draft; also remove one that a
				// save still in flight may have created meanwhile.
				void saveChainRef.current.then(() => {
					if (draftIdRef.current) void deleteDraft(draftIdRef.current);
					draftIdRef.current = null;
				});
				handleCloseRef.current();
				toast.success(formState.message || "Message sent");
			}
		}, [formState]);

		return (
			<div className="mt-4" tabIndex={-1}>
				<DynamicContextProvider
					initialState={{
						isPending,
						message,
						publicConfig,
						showEditorMode,
						currentMode: showEditorMode,
						initialDraft,
						originalAttachments,
						discardDraft,
					}}
				>
					<SyncPendingState isPending={isPending} />
					<Form
						action={formAction}
						ref={formRef}
						onInputCapture={scheduleSave}
						onChangeCapture={scheduleSave}
						onKeyUpCapture={scheduleSave}
						onSubmitCapture={() => {
							// Block autosave while sending; re-enabled on error.
							sendingRef.current = true;
							if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
						}}
					>
						<input type="hidden" name="draftId" value={draftId ?? ""} />
						<input
							type={"hidden"}
							name={"messageMailboxId"}
							value={message?.mailboxId}
						/>
						{!message && senderOptions.length > 0 && (
							<div className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]">
								<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
									From
								</span>
								<Select
									aria-label="From account"
									data={senderOptions}
									value={sentMailboxId || null}
									onChange={(value) => value && onSentMailboxChange?.(value)}
									placeholder="Select sender account"
									variant="unstyled"
									searchable
									allowDeselect={false}
									comboboxProps={{
										withinPortal: true,
										position: "bottom",
										offset: 8,
										zIndex: 2000,
									}}
								/>
							</div>
						)}
						<input
							type={"hidden"}
							name={"sentMailboxId"}
							value={sentMailboxId}
						/>

						<input
							type={"hidden"}
							name={"mailboxId"}
							value={
								sentMailboxId
									? sentMailboxId
									: message?.mailboxId
										? message?.mailboxId
										: ""
							}
						/>
						{aiEnabled && (
							<div
								className="border-b bg-muted/20 px-3 py-2 space-y-2"
								data-no-autosave
							>
								<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
									<Textarea
										aria-label="AI reply instruction"
										value={aiInstruction}
										onChange={(event) =>
											setAiInstruction(event.currentTarget.value)
										}
										placeholder="AI reply notes: e.g. politely decline, keep it short, suggest a meeting next week…"
										autosize
										minRows={1}
										maxRows={4}
										className="flex-1"
									/>
									<Button
										type="button"
										variant="light"
										loading={isAiPending}
										onClick={handleGenerateAiSuggestion}
									>
										AI draft
									</Button>
								</div>
								<p className="text-xs text-muted-foreground">
									Uses the configured AI provider to draft text into the editor.
									Nothing is sent until you review and press Send.
								</p>
							</div>
						)}
						<TextEditor
							name={"html"}
							ref={textEditorRef}
							defaultValue={initialDraft?.payload.bodyHtml ?? ""}
							signatureHtml={signatureHtml}
						/>
					</Form>
				</DynamicContextProvider>
			</div>
		);
	},
);

EmailEditor.displayName = "EmailEditor";
export default EmailEditor;
