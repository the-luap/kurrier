// @ts-nocheck
import "@mantine/tiptap/styles.css";
import { Link, RichTextEditor } from "@mantine/tiptap";
import Image from "@tiptap/extension-image";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import React, {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";

export type TextEditorHandle = {
	focus: (where?: "start" | "end") => void;
	getElement: () => HTMLElement | null;
	getHTML: () => string;
};

type TextEditorProps = {
	name?: string;
	defaultValue?: string;
	onChange?: (html: string) => void;
};

import type { MessageEntity } from "@db";
import { Temporal } from "@js-temporal/polyfill";
import { FocusTrap } from "@mantine/core";
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

export const TextEditor = forwardRef<TextEditorHandle, TextEditorProps>(
	({ name, defaultValue = "", onChange }, ref) => {
		const containerRef = useRef<HTMLDivElement>(null);
		const [value, setValue] = useState(() => toEmailHtml(defaultValue));
		const [textValue, setTextValue] = useState("");

		const editor = useEditor({
			immediatelyRender: false,
			parseOptions: { preserveWhitespace: "full" },
			extensions: [StarterKit, Link, Image],
			content: defaultValue,
			onUpdate: ({ editor }) => {
				setTextValue(editor.getText().trim());
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
			setTextValue(editor.getText().trim());
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
			}),
			[editor, value],
		);

		const { state } = useDynamicContext<{
			isPending: boolean;
			message: MessageEntity;
			showEditorMode: "reply" | "forward" | "compose";
		}>();

		const [focusOnSubject, setFocusOnSubject] = useState<boolean>(false);

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
					<EditorHeader focusOnSubject={setFocusOnSubject} />
					<FocusTrap active={focusOnSubject}>
						<RichTextEditor.Content className="prose min-h-96 text-sm p-2 leading-5" />
					</FocusTrap>
					<EditorFooter />
				</RichTextEditor>

				{/*<span className="text-xs text-neutral-500">*/}
				{/*	Press Shift + Enter for a line break*/}
				{/*</span>*/}
				{name ? (
					<>
						<input type="hidden" name={name} value={value} readOnly />
						<input type="hidden" name={`text`} value={textValue} readOnly />
					</>
				) : null}
			</div>
		);
	},
);

TextEditor.displayName = "TextEditor";
