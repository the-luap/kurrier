"use client";

import { Button, Textarea } from "@mantine/core";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { aiErrorText, useAiDict } from "@/components/dashboard/ai/ai-i18n";
import {
	fetchAiDraftStatus,
	generateAiReplySuggestion,
} from "@/lib/actions/ai";

export type AiDraftPanelProps = {
	/** Composer mode, passed to the prompt. */
	mode: "compose" | "reply" | "forward" | (string & {});
	/** Message being replied to / forwarded. Its body is loaded server-side. */
	originalMessageId?: string | null;
	/** Current editor HTML (sent as context, and checked before replacing). */
	getCurrentHtml: () => string;
	/** Optional plain text of the editor; derived from the HTML otherwise. */
	getCurrentText?: () => string;
	/** Replace the editor content with the generated HTML. */
	onInsert: (html: string) => void;
	className?: string;
};

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[char] ?? char,
	);

const plainTextToHtml = (value: string) =>
	value
		.replace(/\r\n?/g, "\n")
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map(
			(paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`,
		)
		.join("");

const htmlToText = (html: string) => {
	if (!html) return "";
	try {
		return (
			new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
		);
	} catch {
		return html.replace(/<[^>]+>/g, " ");
	}
};

/**
 * AI reply assistant for the mail composer. Renders nothing until the
 * user has enabled AI drafts in Platform > AI assistant. The generated text
 * only replaces the editor content (after confirmation when it is not
 * empty); nothing is sent.
 */
export default function AiDraftPanel({
	mode,
	originalMessageId,
	getCurrentHtml,
	getCurrentText,
	onInsert,
	className,
}: AiDraftPanelProps) {
	const dict = useAiDict();
	const [enabled, setEnabled] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [isPending, setIsPending] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetchAiDraftStatus()
			.then((status) => {
				if (!cancelled) setEnabled(Boolean(status?.enabled));
			})
			.catch(() => {
				if (!cancelled) setEnabled(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!enabled) return null;

	const handleGenerate = async () => {
		if (isPending) return;
		setIsPending(true);
		try {
			const currentHtml = getCurrentHtml() || "";
			const result = await generateAiReplySuggestion({
				mode,
				userInstruction: instruction,
				currentHtml,
				originalMessageId: originalMessageId
					? String(originalMessageId)
					: undefined,
			});

			if (!result?.success) {
				toast.error(dict.panel.failed, {
					description: aiErrorText(dict, result?.error, result?.data?.provider),
				});
				return;
			}

			const suggestion = String(result.data?.suggestion ?? "").trim();
			if (!suggestion) {
				toast.error(dict.panel.failed, {
					description: aiErrorText(
						dict,
						"emptySuggestion",
						result.data?.provider,
					),
				});
				return;
			}

			// Re-read the editor: the user may have typed while waiting.
			const existingText = (
				getCurrentText ? getCurrentText() : htmlToText(getCurrentHtml() || "")
			).trim();
			if (existingText && !window.confirm(dict.panel.confirmReplace)) {
				return;
			}

			onInsert(plainTextToHtml(suggestion));
			toast.success(dict.panel.inserted, {
				description: dict.panel.insertedHint,
			});
		} catch {
			toast.error(dict.panel.failed, {
				description: aiErrorText(dict, "generic"),
			});
		} finally {
			setIsPending(false);
		}
	};

	return (
		<div
			className={className ?? "space-y-2 border-b bg-muted/20 px-3 py-2"}
			data-no-autosave
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<Textarea
					aria-label={dict.panel.instructionLabel}
					value={instruction}
					onChange={(event) => setInstruction(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							void handleGenerate();
						}
					}}
					placeholder={dict.panel.instructionPlaceholder}
					maxLength={1200}
					autosize
					minRows={1}
					maxRows={4}
					className="flex-1"
				/>
				<Button
					type="button"
					variant="light"
					loading={isPending}
					onClick={() => void handleGenerate()}
					leftSection={<Sparkles size={16} />}
				>
					{dict.panel.generate}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">{dict.panel.hint}</p>
		</div>
	);
}
