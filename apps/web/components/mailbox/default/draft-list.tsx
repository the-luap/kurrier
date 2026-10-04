"use client";

import * as React from "react";
import dayjs from "dayjs";
import { FileText, Paperclip, Reply, Forward, Trash } from "lucide-react";
import { ActionIcon } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DraftMessageEntity } from "@db";
import { deleteDraft, type DraftPayload } from "@/lib/actions/mailbox";

export const OPEN_DRAFT_EVENT = "kurrier:open-draft";

export type OpenDraftDetail = {
	id: string;
	mailboxId: string;
	payload: DraftPayload;
};

function formatDateLabel(input?: string | number | Date | null) {
	if (!input) return "";
	const d = dayjs(input);
	if (!d.isValid()) return "";
	const now = dayjs();
	if (d.isSame(now, "day")) return d.format("h:mm A");
	if (d.isSame(now, "year")) return d.format("MMM D, h:mm A");
	return d.format("MMM D, YYYY");
}

function hasAttachments(payload: DraftPayload) {
	try {
		const parsed = JSON.parse(String(payload?.attachments ?? "[]"));
		return Array.isArray(parsed) && parsed.length > 0;
	} catch {
		return false;
	}
}

function DraftListItem({ draft }: { draft: DraftMessageEntity }) {
	const router = useRouter();
	const payload = (draft.payload ?? {}) as DraftPayload;
	const [deleting, setDeleting] = React.useState(false);
	const isReply = payload.mode === "reply" || payload.mode === "forward";
	const ModeIcon =
		payload.mode === "reply" ? Reply : payload.mode === "forward" ? Forward : FileText;
	const preview = String(payload.text ?? "")
		.replace(/\s+/g, " ")
		.trim();

	const open = () => {
		if (isReply && payload.threadUrl) {
			// Reply/forward drafts are restored when the editor is opened again.
			router.push(payload.threadUrl);
			return;
		}
		window.dispatchEvent(
			new CustomEvent<OpenDraftDetail>(OPEN_DRAFT_EVENT, {
				detail: { id: draft.id, mailboxId: draft.mailboxId, payload },
			}),
		);
	};

	return (
		<li
			className="px-3 py-2 transition-colors hover:bg-muted/50 cursor-pointer"
			onClick={open}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 min-w-0">
						<ModeIcon className="h-4 w-4 text-muted-foreground shrink-0" />
						<div className="truncate font-semibold">
							{payload.to || "No recipients"}
						</div>
						{hasAttachments(payload) && (
							<Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
						)}
					</div>
					<div className="truncate text-sm text-muted-foreground">
						<span>{payload.subject || "(no subject)"}</span>
						{preview && <span className="mx-1">–</span>}
						{preview && <span>{preview}</span>}
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<span className="text-xs text-muted-foreground whitespace-nowrap">
						{formatDateLabel(draft.updatedAt)}
					</span>
					<ActionIcon
						size="sm"
						variant="light"
						title="Discard draft"
						loading={deleting}
						onClick={async (e) => {
							e.stopPropagation();
							setDeleting(true);
							try {
								await deleteDraft(draft.id);
								toast.success("Draft discarded", { position: "bottom-left" });
								router.refresh();
							} catch (error) {
								setDeleting(false);
								toast.error(
									error instanceof Error ? error.message : "Delete failed",
									{ position: "bottom-left" },
								);
							}
						}}
					>
						<Trash size={14} />
					</ActionIcon>
				</div>
			</div>
		</li>
	);
}

export default function DraftList({ drafts }: { drafts: DraftMessageEntity[] }) {
	if (drafts.length === 0) {
		return (
			<div className="p-4 text-center text-base text-muted-foreground">
				No drafts
			</div>
		);
	}

	return (
		<div className="rounded-xl border bg-background/50">
			<div className="flex items-center justify-between px-3 py-2 border-b">
				<div className="text-sm font-semibold">Drafts</div>
				<div className="text-xs text-muted-foreground">{drafts.length}</div>
			</div>
			<ul role="list" className="divide-y">
				{drafts.map((draft) => (
					<DraftListItem key={draft.id} draft={draft} />
				))}
			</ul>
		</div>
	);
}
