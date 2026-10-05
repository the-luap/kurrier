"use client";

import { Tooltip } from "@mantine/core";
import { Clock4 } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { snoozeThread } from "@/lib/actions/mailbox";

// Loaded on first open: keeps @vvo/tzdb, @mantine/dates and two Modals out
// of every mailbox row.
const SnoozeMailDialog = dynamic(
	() => import("@/components/mailbox/default/snooze-mail-dialog"),
	{ ssr: false },
);

function formatWhen(d: Date) {
	const pad = (n: number) => String(n).padStart(2, "0");
	const h24 = d.getHours();
	const h12 = ((h24 + 11) % 12) + 1;
	const ampm = h24 >= 12 ? "PM" : "AM";
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${h12}:${pad(d.getMinutes())} ${ampm}`;
}

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
		? `Snoozed • ${formatWhen(snoozedUntil)}`
		: "Snooze";

	async function commit(next: Date | null) {
		if (saving) return;

		setSaving(true);
		try {
			await snoozeThread({
				mailboxThreadId,
				activeMailboxId,
				snoozedUntil: next ? next.toISOString() : null,
			});

			setSnoozedUntil(next);
			setDialogOpen(false);
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
