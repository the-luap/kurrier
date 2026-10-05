"use client";

import { ActionIcon } from "@mantine/core";
import { FileText, Forward, Paperclip, Reply, Trash } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import {
	OPEN_DRAFT_EVENT,
	type OpenDraftDetail,
} from "@/components/mailbox/default/composer/draft-events";
import { useIsClient } from "@/components/mailbox/default/thread-list-utils";
import { useOptionalDictionary } from "@/components/providers/dictionary-provider";
import {
	type DraftPayload,
	type DraftRow,
	deleteDraft,
} from "@/lib/actions/drafts";

function formatDateLabel(input: Date | string | null, locale?: string) {
	if (!input) return "";
	const date = new Date(input);
	if (Number.isNaN(date.getTime())) return "";
	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return new Intl.DateTimeFormat(locale, {
			hour: "numeric",
			minute: "2-digit",
		}).format(date);
	}
	if (date.getFullYear() === now.getFullYear()) {
		return new Intl.DateTimeFormat(locale, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}).format(date);
	}
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function hasAttachments(payload: DraftPayload) {
	try {
		const parsed = JSON.parse(String(payload?.attachments || "[]"));
		return Array.isArray(parsed) && parsed.length > 0;
	} catch {
		return false;
	}
}

function DraftListItem({ draft }: { draft: DraftRow }) {
	const router = useRouter();
	const dict = useOptionalDictionary();
	const payload = (draft.payload ?? {}) as DraftPayload;
	const [deleting, setDeleting] = React.useState(false);
	// Viewer-timezone label on the client only, so SSR and hydration agree.
	const isClient = useIsClient();

	const isReply = payload.mode === "reply" || payload.mode === "forward";
	const ModeIcon =
		payload.mode === "reply"
			? Reply
			: payload.mode === "forward"
				? Forward
				: FileText;
	const modeLabel =
		payload.mode === "reply"
			? (dict?.mailbox?.reply ?? "Reply")
			: payload.mode === "forward"
				? (dict?.mailbox?.forward ?? "Forward")
				: (dict?.mailbox?.newMessage ?? "New message");
	const subject = payload.subject || (dict?.mailbox?.noSubject ?? "(no subject)");
	const recipients = String(payload.to ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.join(", ");
	const preview = String(payload.text ?? "")
		.replace(/\s+/g, " ")
		.trim();

	const open = () => {
		if (isReply && payload.threadUrl) {
			// Reply/forward drafts are restored when the composer for the
			// message is opened again.
			router.push(payload.threadUrl);
			return;
		}
		window.dispatchEvent(
			new CustomEvent<OpenDraftDetail>(OPEN_DRAFT_EVENT, {
				detail: { id: draft.id, payload },
			}),
		);
	};

	const discard = async () => {
		setDeleting(true);
		try {
			await deleteDraft(draft.id);
			toast.success(dict?.mailbox?.draftDiscarded ?? "Draft discarded", {
				position: "bottom-left",
			});
			router.refresh();
		} catch (error) {
			setDeleting(false);
			toast.error(dict?.common?.error ?? "Error", {
				description: error instanceof Error ? error.message : undefined,
				position: "bottom-left",
			});
		}
	};

	return (
		<li className="flex items-start gap-3 px-3 py-2 transition-colors hover:bg-muted/50 has-[:focus-visible]:bg-muted/50">
			<button
				type="button"
				onClick={open}
				aria-label={`${dict?.mailbox?.openDraft ?? "Open draft"}: ${subject}`}
				className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none"
			>
				<div className="flex min-w-0 items-center gap-2">
					<ModeIcon
						className="h-4 w-4 shrink-0 text-muted-foreground"
						aria-label={modeLabel}
					/>
					<div className="truncate font-semibold">
						{recipients || (dict?.mailbox?.noRecipients ?? "No recipients")}
					</div>
					{hasAttachments(payload) && (
						<Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
					)}
				</div>
				<div className="truncate text-sm text-muted-foreground">
					<span>{subject}</span>
					{preview && <span className="mx-1">–</span>}
					{preview && <span>{preview}</span>}
				</div>
			</button>

			<div className="flex shrink-0 items-center gap-2">
				<span className="whitespace-nowrap text-xs text-muted-foreground">
					{isClient ? formatDateLabel(draft.updatedAt, dict?.locale) : ""}
				</span>
				<ActionIcon
					size="sm"
					variant="light"
					title={dict?.mailbox?.discardDraft ?? "Discard draft"}
					aria-label={dict?.mailbox?.discardDraft ?? "Discard draft"}
					loading={deleting}
					onClick={discard}
				>
					<Trash size={14} />
				</ActionIcon>
			</div>
		</li>
	);
}

export default function DraftList({ drafts }: { drafts: DraftRow[] }) {
	const dict = useOptionalDictionary();

	if (drafts.length === 0) {
		return (
			<div className="p-4 text-center text-base text-muted-foreground">
				{dict?.mailbox?.noDrafts ?? "No drafts"}
			</div>
		);
	}

	return (
		<div className="rounded-xl border bg-background/50">
			<div className="flex items-center justify-between border-b px-3 py-2">
				<h2 className="text-sm font-semibold">
					{dict?.mailbox?.folderDrafts ?? "Drafts"}
				</h2>
				<div className="text-xs text-muted-foreground">{drafts.length}</div>
			</div>
			<ul className="divide-y">
				{drafts.map((draft) => (
					<DraftListItem key={draft.id} draft={draft} />
				))}
			</ul>
		</div>
	);
}
