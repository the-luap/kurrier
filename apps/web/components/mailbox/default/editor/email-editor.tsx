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
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";
import { generateAiReplySuggestion, sendMail } from "@/lib/actions/mailbox";

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
		},
		ref,
	) => {
		const textEditorRef = useRef<TextEditorHandle>(null);
		const [aiInstruction, setAiInstruction] = React.useState("");
		const [isAiPending, setIsAiPending] = React.useState(false);

		useImperativeHandle(
			ref,
			() => ({
				focus: () => textEditorRef.current?.focus("end"),
				getElement: () => textEditorRef.current?.getElement() ?? null,
			}),
			[],
		);

		useEffect(() => {
			const el = textEditorRef.current?.getElement();
			if (el) onReady?.(el);
		}, [onReady]);

		const [formState, formAction, isPending] = useActionState<
			FormState,
			FormData
		>(sendMail, {});

		useEffect(() => {
			if (formState.error) {
				toast.error("Error", {
					description: formState.error,
				});
			} else if (formState.success) {
				handleClose();
				toast.success("Success", {
					description: formState.success,
				});
			}
		}, [formState, handleClose]);

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

		const preserveSignature = (currentHtml: string) => {
			const match = currentHtml.match(
				/<div class="kurrier-signature">[\s\S]*?<\/div>\s*$/i,
			);
			return match?.[0] || "";
		};

		const getSuggestionText = (data: unknown) => {
			if (!data || typeof data !== "object" || !("suggestion" in data))
				return "";
			const suggestion = (data as { suggestion?: unknown }).suggestion;
			return typeof suggestion === "string" ? suggestion.trim() : "";
		};

		const handleGenerateAiSuggestion = async () => {
			setIsAiPending(true);
			try {
				const currentHtml = textEditorRef.current?.getHTML() || "";
				const result = await generateAiReplySuggestion({
					mode: showEditorMode,
					userInstruction: aiInstruction,
					currentHtml,
					originalSubject: message?.subject,
					originalText: message?.text || message?.snippet,
					originalHtml: message?.html,
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

				const signature = preserveSignature(currentHtml);
				textEditorRef.current?.setHTML(
					`${plainTextToHtml(suggestion)}${signature}`,
				);
				textEditorRef.current?.focus("end");
				toast.success("AI suggestion inserted", {
					description: "Review and edit it before sending.",
				});
			} finally {
				setIsAiPending(false);
			}
		};

		return (
			<div className="mt-4" tabIndex={-1}>
				<DynamicContextProvider
					initialState={{ isPending, message, publicConfig, showEditorMode }}
				>
					<Form action={formAction}>
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
						<div className="border-b bg-muted/20 px-3 py-2 space-y-2">
							<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
								<Textarea
									aria-label="AI reply instruction"
									value={aiInstruction}
									onChange={(event) =>
										setAiInstruction(event.currentTarget.value)
									}
									placeholder="AI reply notes: e.g. höflich absagen, kurz auf Deutsch, Termin nächste Woche vorschlagen…"
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
						<TextEditor
							name={"html"}
							ref={textEditorRef}
							defaultValue={
								signatureHtml
									? `<p></p><div class="kurrier-signature">${signatureHtml}</div>`
									: ""
							}
						/>
					</Form>
				</DynamicContextProvider>
			</div>
		);
	},
);

EmailEditor.displayName = "EmailEditor";
export default EmailEditor;
