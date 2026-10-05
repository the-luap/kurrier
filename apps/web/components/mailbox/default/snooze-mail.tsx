"use client";

import { Tooltip } from "@mantine/core";
import { Clock4 } from "lucide-react";
import dynamic from "next/dynamic";
import type { FormState } from "@schema";
import { useState } from "react";
import { toast } from "sonner";
import { useOptionalI18n } from "@/components/providers/dictionary-provider";
import { snoozeThread } from "@/lib/actions/mailbox";

// Loaded on first open: keeps @vvo/tzdb, @mantine/dates and two Modals out
// of every mailbox row.
const SnoozeMailDialog = dynamic(
	() => import("@/components/mailbox/default/snooze-mail-dialog"),
	{ ssr: false },
);

type Props = {
	mailboxThreadId: string;
	activeMailboxId: string;
	initialSnoozedUntil?: Date | null;
};

export default function SnoozeMail({
	mailboxThreadId,
	activeMailboxId,
	initialSnoozedUntil = null,
}: Props) {
	const i18n = useOptionalI18n();
	const dict = i18n?.dict;
	const format = i18n?.format;
	const [snoozedUntil, setSnoozedUntil] = useState<Date | null>(
		initialSnoozedUntil,
	);
	const [saving, setSaving] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	// Mount the (lazy) dialog on first open and keep it mounted afterwards so
	// the Modal open/close transitions still play.
	const [dialogLoaded, setDialogLoaded] = useState(false);

	const snoozed = !!snoozedUntil;
	const label = snoozedUntil
		? `${dict?.mailbox?.snoozedBullet ?? "Snoozed • "}${
				format?.date(snoozedUntil, {
					dateStyle: "medium",
					timeStyle: "short",
				}) ?? snoozedUntil.toLocaleString()
			}`
		: (dict?.mailbox?.snooze ?? "Snooze");

	async function commit(next: Date | null) {
		if (saving) return;

		setSaving(true);
		try {
			// handleAction reports failures in the result instead of throwing.
			const result: FormState = await snoozeThread({
				mailboxThreadId,
				activeMailboxId,
				snoozedUntil: next ? next.toISOString() : null,
			});
			if (!result?.success) {
				throw new Error(result?.error);
			}

			setSnoozedUntil(next);
			setDialogOpen(false);
		} catch (error) {
			toast.error(dict?.mailbox?.actionFailed ?? "Action failed", {
				description: error instanceof Error ? error.message : undefined,
				position: "bottom-left",
			});
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			{dialogLoaded && (
				<SnoozeMailDialog
					opened={dialogOpen}
					saving={saving}
					onCommit={(next) => void commit(next)}
					onClose={() => setDialogOpen(false)}
				/>
			)}

			<div className="inline-flex items-center gap-1 mx-1">
				<Tooltip label={label} withArrow position="top" openDelay={250}>
					<button
						type="button"
						disabled={saving}
						aria-label={label}
						onClick={() => {
							if (snoozed) {
								void commit(null);
								return;
							}
							setDialogLoaded(true);
							setDialogOpen(true);
						}}
					>
						<Clock4 size={16} />
					</button>
				</Tooltip>
			</div>
		</>
	);
}
