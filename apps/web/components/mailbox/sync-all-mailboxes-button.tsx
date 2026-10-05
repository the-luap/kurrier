"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useOptionalI18n } from "@/components/providers/dictionary-provider";
import { Button } from "@/components/ui/button";
import {
	deltaFetchAllMailboxes,
	getDeltaFetchStatus,
} from "@/lib/actions/mailbox";
import { cn } from "@/lib/utils";

const SYNC_POLL_MS = 2000;
const SYNC_POLL_ATTEMPTS = 30;

/** Job states that will not change any more ("missing": cleaned up after completion). */
const DONE_STATES = new Set(["completed", "failed", "missing"]);

export default function SyncAllMailboxesButton({
	disabled,
}: {
	disabled?: boolean;
}) {
	const router = useRouter();
	const i18n = useOptionalI18n();
	const dict = i18n?.dict?.mailbox;
	const format = i18n?.format;
	const [syncing, setSyncing] = useState(false);

	const plural = (
		count: number,
		forms: { other: string } | undefined,
		fallback: string,
	) =>
		forms && format
			? format.message(count, forms)
			: fallback.replace("{count}", String(count));

	const syncAll = async () => {
		setSyncing(true);
		const toastId = toast.loading(dict?.syncStarting ?? "Starting sync…", {
			position: "bottom-left",
		});

		try {
			const result = await deltaFetchAllMailboxes();

			if (result.queued === 0) {
				if (result.success) {
					toast.info(
						dict?.syncAllNone ?? "No mailboxes available to sync.",
						{ id: toastId, position: "bottom-left" },
					);
				} else {
					toast.error(dict?.syncFailed ?? "Sync failed", {
						id: toastId,
						description: result.error ?? undefined,
						position: "bottom-left",
					});
				}
				return;
			}

			toast.loading(
				plural(
					result.queued,
					dict?.syncAllRunning,
					"Syncing {count} mailboxes…",
				),
				{ id: toastId, position: "bottom-left" },
			);

			// Wait for the jobs so the refresh actually shows the new mail.
			const pending = new Set(result.jobIds);
			let failed = result.failed;
			for (
				let attempt = 0;
				attempt < SYNC_POLL_ATTEMPTS && pending.size > 0;
				attempt++
			) {
				await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS));
				const statuses = await Promise.all(
					[...pending].map((jobId) => getDeltaFetchStatus({ jobId })),
				);
				for (const status of statuses) {
					if (!DONE_STATES.has(status.state)) continue;
					pending.delete(status.jobId);
					if (status.state === "failed") failed++;
				}
			}

			router.refresh();

			if (pending.size > 0) {
				toast.info(
					dict?.syncStillRunning ?? "Sync is still running in the background",
					{ id: toastId, position: "bottom-left" },
				);
			} else if (failed > 0) {
				toast.warning(
					plural(
						failed,
						dict?.syncAllSomeFailed,
						"{count} mailboxes could not be synced.",
					),
					{ id: toastId, position: "bottom-left" },
				);
			} else {
				toast.success(dict?.syncCompleted ?? "Sync completed", {
					id: toastId,
					position: "bottom-left",
				});
			}
		} catch (error) {
			toast.error(dict?.syncFailed ?? "Sync failed", {
				id: toastId,
				description: error instanceof Error ? error.message : undefined,
				position: "bottom-left",
			});
		} finally {
			setSyncing(false);
		}
	};

	const title = dict?.syncAllTitle ?? "Sync all mailboxes";

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={syncAll}
			disabled={disabled || syncing}
			className="shrink-0"
			title={title}
			aria-label={title}
		>
			<RotateCw className={cn("h-4 w-4", syncing && "animate-spin")} />
			<span>{dict?.syncAll ?? "Sync all"}</span>
		</Button>
	);
}
