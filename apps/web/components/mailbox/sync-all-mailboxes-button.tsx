"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { deltaFetchAllMailboxes } from "@/lib/actions/mailbox";
import { cn } from "@/lib/utils";

type SyncAllMailboxesButtonProps = {
	disabled?: boolean;
};

export default function SyncAllMailboxesButton({
	disabled,
}: SyncAllMailboxesButtonProps) {
	const router = useRouter();
	const [syncing, setSyncing] = useState(false);

	const syncAll = async () => {
		const toastId = toast.loading("Starting sync for all mailboxes…", {
			position: "bottom-left",
		});

		try {
			setSyncing(true);
			const result = await deltaFetchAllMailboxes();

			if (!result.success) {
				toast.error(result.error ?? "Could not start sync.", {
					id: toastId,
					position: "bottom-left",
				});
				return;
			}

			if (result.queued === 0) {
				toast.info("No mailboxes available to sync.", {
					id: toastId,
					position: "bottom-left",
				});
				return;
			}

			toast.success(
				`Sync started for ${result.queued} mailbox${result.queued === 1 ? "" : "es"}.`,
				{
					id: toastId,
					position: "bottom-left",
				},
			);
			router.refresh();
		} catch (error) {
			toast.error(
				`Could not start sync: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ id: toastId, position: "bottom-left" },
			);
		} finally {
			setSyncing(false);
		}
	};

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={syncAll}
			disabled={disabled || syncing}
			className="shrink-0"
			title="Sync all mailboxes"
		>
			<RotateCw className={cn("h-4 w-4", syncing && "animate-spin")} />
			<span>Sync all</span>
		</Button>
	);
}
