"use client";
import type { MessageEntity } from "@db";
import { Select } from "@mantine/core";
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
import { sendMail } from "@/lib/actions/mailbox";

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
		}, [formState]);

		return (
			<>
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
			</>
		);
	},
);

EmailEditor.displayName = "EmailEditor";
export default EmailEditor;
