// @ts-nocheck
import "@mantine/tiptap/styles.css";
import { Link, RichTextEditor } from "@mantine/tiptap";
import Image from "@tiptap/extension-image";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import DOMPurify from "dompurify";
import React, {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";

export type TextEditorHandle = {
	focus: (where?: "start" | "end") => void;
	getElement: () => HTMLElement | null;
	getHTML: () => string;
	getText: () => string;
	setHTML: (html: string) => void;
};

type TextEditorProps = {
	name?: string;
	defaultValue?: string;
	onChange?: (html: string) => void;
	signatureHtml?: string | null;
};

import type { MessageEntity } from "@db";
import { Temporal } from "@js-temporal/polyfill";
import EditorFooter from "@/components/mailbox/default/editor/editor-footer";
import EditorHeader from "@/components/mailbox/default/editor/editor-header";
import { useDynamicContext } from "@/hooks/use-dynamic-context";

function formatWhen(d: Date) {
	return Temporal.Instant.from(d.toISOString())
		.toZonedDateTimeISO(Temporal.Now.timeZoneId())
		.toLocaleString("en-GB", {
			day: "2-digit",
			month: "short",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
}

// Empty paragraphs from the editor ("<p></p>") collapse to zero height in
// most mail clients, so blank lines typed by the user would disappear.
function toEmailHtml(html: string) {
	return html.trim().replace(/<p([^>]*)><\/p>/g, "<p$1><br></p>");
}

function htmlToText(html: string) {
	if (typeof document === "undefined") return "";
	const el = document.createElement("div");
	el.innerHTML = html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li)>/gi, "\n");
	return (el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export const TextEditor = forwardRef<TextEditorHandle, TextEditorProps>(
	({ name, defaultValue = "", onChange, signatureHtml }, ref) => {
		const containerRef = useRef<HTMLDivElement>(null);
		const [value, setValue] = useState(() => toEmailHtml(defaultValue));
		const [textValue, setTextValue] = useState("");

		const editor = useEditor({
			immediatelyRender: false,
			parseOptions: { preserveWhitespace: "full" },
			extensions: [StarterKit, Link, Image],
			content: defaultValue,
			onUpdate: ({ editor }) => {
				setTextValue(editor.getText({ blockSeparator: "\n" }).trim());
				setValue(toEmailHtml(editor.getHTML()));
			},
		});

		// Re-apply defaultValue (e.g. the signature after switching sender) only
		// while the user has not typed anything, otherwise the draft is lost.
		const appliedHtmlRef = useRef<string | null>(null);
		useEffect(() => {
			if (!editor) return;
			const current = editor.getHTML();
			const pristine =
				appliedHtmlRef.current === null
					? true
					: current === appliedHtmlRef.current || editor.isEmpty;
			if (!pristine) return;
			editor.commands.setContent(defaultValue || "");
			appliedHtmlRef.current = editor.getHTML();
			setTextValue(editor.getText({ blockSeparator: "\n" }).trim());
			setValue(toEmailHtml(editor.getHTML()));
		}, [defaultValue, editor]);

		useImperativeHandle(
			ref,
			() => ({
				focus: (where = "end") => {
					if (!editor) return;
					editor.commands.focus(where);
				},
				getElement: () => containerRef.current,
				getHTML: () => value,
				getText: () => textValue,
				setHTML: (html: string) => {
					if (!editor) return;
					editor.commands.setContent(html || "");
					setTextValue(editor.getText({ blockSeparator: "\n" }).trim());
					setValue(toEmailHtml(editor.getHTML()));
				},
			}),
			[editor, value, textValue],
		);

		// The signature is identity HTML (tables, inline styles, images) that
		// the rich text schema would flatten. Show it as a read-only preview and
		// append it unchanged when sending.
		const [includeSignature, setIncludeSignature] = useState(true);
		const safeSignature = useMemo(() => {
			if (!signatureHtml?.trim() || typeof window === "undefined") return "";
			return DOMPurify.sanitize(signatureHtml, {
				USE_PROFILES: { html: true },
				FORBID_TAGS: ["form", "input", "button", "textarea", "select"],
			});
		}, [signatureHtml]);
		const activeSignature = includeSignature ? safeSignature : "";
		const submitHtml = activeSignature
			? `${value}<br><div class="kurrier-signature">${activeSignature}</div>`
			: value;
		const submitText = activeSignature
			? `${textValue}\n\n-- \n${htmlToText(activeSignature)}`
			: textValue;

		const { state } = useDynamicContext<{
			isPending: boolean;
			message: MessageEntity;
			showEditorMode: "reply" | "forward" | "compose";
		}>();

		return (
			<div ref={containerRef} className="scroll-mt-[72px]">
				<RichTextEditor
					editor={editor}
					className={
						!state.message
							? "!border-0 -mt-4"
							: "!border !rounded-t-md !border-neutral-200"
					}
				>
					<EditorHeader
						focusOnSubject={() => editor?.commands.focus("start")}
					/>
					<RichTextEditor.Content className="prose min-h-96 text-sm p-2 leading-5" />
					{safeSignature && (
						<div className="group relative mx-2 mb-2 border-t border-dashed pt-2 text-sm text-muted-foreground">
							{includeSignature ? (
								<>
									<div
										className="kurrier-signature-preview"
										// biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify sanitizes identity HTML immediately above.
										dangerouslySetInnerHTML={{ __html: safeSignature }}
									/>
									<button
										type="button"
										className="absolute right-0 top-1 text-xs opacity-60 hover:opacity-100 hover:underline"
										onClick={() => setIncludeSignature(false)}
									>
										Remove signature
									</button>
								</>
							) : (
								<button
									type="button"
									className="text-xs hover:underline"
									onClick={() => setIncludeSignature(true)}
								>
									Add signature
								</button>
							)}
						</div>
					)}
					<EditorFooter />
				</RichTextEditor>

				{/*<span className="text-xs text-neutral-500">*/}
				{/*	Press Shift + Enter for a line break*/}
				{/*</span>*/}
				{name ? (
					<>
						<input type="hidden" name={name} value={submitHtml} readOnly />
						<input type="hidden" name={`text`} value={submitText} readOnly />
					</>
				) : null}
			</div>
		);
	},
);

TextEditor.displayName = "TextEditor";
