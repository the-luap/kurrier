"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import { ActionIcon, Button, Tooltip } from "@mantine/core";
import type { PublicConfig } from "@schema";
import { clsx } from "clsx";
import {
	Ban,
	Mail,
	MailOpen,
	RotateCw,
	Star,
	StarOff,
	Trash2,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import MailComposerLauncher from "@/components/mailbox/default/composer/mail-composer-launcher";
import MoveToFolder from "@/components/mailbox/default/move-to-folder";
import { useOptionalDictionary } from "@/components/providers/dictionary-provider";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import {
	deleteForever,
	deltaFetch,
	type FetchIdentityMailboxListResult,
	type FetchMailboxThreadsResult,
	getDeltaFetchStatus,
	markAsRead,
	markAsUnread,
	moveToSpam,
	moveToTrash,
	revalidateMailbox,
	setStarForThreads,
} from "@/lib/actions/mailbox";

const SYNC_POLL_MS = 2000;
const SYNC_POLL_ATTEMPTS = 30;

function MailListHeader({
	mailboxThreads,
	mailboxSync,
	publicConfig,
	identityMailboxes,
	activeMailbox,
}: {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	identityMailboxes: FetchIdentityMailboxListResult;
	activeMailbox: MailboxEntity;
	mailboxSync?: MailboxSyncEntity;
}) {
	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		activeMailbox?: MailboxEntity | null;
		identityPublicId: string;
	}>();
	const dict = useOptionalDictionary();
	const router = useRouter();

	const mailboxId = activeMailbox.id;
	const mailboxKind = activeMailbox.kind;
	const markImap = !!mailboxSync;

	// Inbound-only identities cannot send (same filter as the sidebar).
	const sendableIdentityMailboxes = useMemo(
		() =>
			identityMailboxes.filter(
				(item) => item.identity?.metaData?.provider !== "inbound",
			),
		[identityMailboxes],
	);

	const selectedSize = state?.selectedThreadIds?.size ?? 0;
	const hasSelected = selectedSize > 0;
	const isChecked =
		selectedSize === mailboxThreads.length && mailboxThreads.length > 0;

	const [reloading, setReloading] = useState(false);
	// Starts a background sync, then polls the job so the action never blocks
	// on the whole sync (and never times out).
	const reload = async () => {
		if (reloading) return;

		if (!mailboxSync || !activeMailbox.identityId) {
			try {
				await revalidateMailbox("/mail");
				router.refresh();
				toast.success(dict?.mailbox?.mailboxRefreshed ?? "Mailbox refreshed", {
					position: "bottom-left",
				});
			} catch (error) {
				toast.error(dict?.mailbox?.actionFailed ?? "Action failed", {
					description: error instanceof Error ? error.message : undefined,
					position: "bottom-left",
				});
			}
			return;
		}

		setReloading(true);
		const toastId = toast.loading(dict?.mailbox?.syncStarting ?? "Starting sync…", {
			position: "bottom-left",
		});

		try {
			const result = await deltaFetch({ identityId: activeMailbox.identityId });

			if (!result.success || !result.jobId) {
				toast.error(dict?.mailbox?.syncFailed ?? "Sync failed", {
					id: toastId,
					description: result.error ?? undefined,
					position: "bottom-left",
				});
				return;
			}

			toast.loading(
				dict?.mailbox?.syncRunning ?? "Sync running in the background…",
				{ id: toastId, position: "bottom-left" },
			);

			for (let attempt = 0; attempt < SYNC_POLL_ATTEMPTS; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS));
				const status = await getDeltaFetchStatus({ jobId: result.jobId });

				// "missing": finished jobs are removed from the queue.
				if (status.state === "completed" || status.state === "missing") {
					toast.success(dict?.mailbox?.syncCompleted ?? "Sync completed", {
						id: toastId,
						position: "bottom-left",
					});
					await revalidateMailbox("/mail");
					router.refresh();
					return;
				}

				if (status.state === "failed") {
					toast.error(dict?.mailbox?.syncFailed ?? "Sync failed", {
						id: toastId,
						description: status.error ?? undefined,
						position: "bottom-left",
					});
					return;
				}
			}

			toast.info(
				dict?.mailbox?.syncStillRunning ??
					"Sync is still running in the background",
				{ id: toastId, position: "bottom-left" },
			);
			await revalidateMailbox("/mail");
			router.refresh();
		} catch (error) {
			toast.error(dict?.mailbox?.syncFailed ?? "Sync failed", {
				id: toastId,
				description: error instanceof Error ? error.message : undefined,
				position: "bottom-left",
			});
		} finally {
			setReloading(false);
		}
	};

	const selectedThreads = () => Array.from(state?.selectedThreadIds ?? []);

	const clearSelection = () => {
		setState((prev) => ({
			...(prev ?? {}),
			selectedThreadIds: new Set<string>(),
		}));
	};

	const [isBusy, startBusy] = useTransition();

	// Runs a bulk action with a busy state; failures surface as a toast
	// instead of an unhandled rejection (and no false success toast).
	const runBulk = (
		action: (threadIds: string[]) => Promise<unknown>,
		successMessage: string,
		requireSelection = true,
	) => {
		const threadIds = selectedThreads();
		if (requireSelection && !threadIds.length) return;
		startBusy(async () => {
			try {
				await action(threadIds);
				toast.success(successMessage, { position: "bottom-left" });
				clearSelection();
				router.refresh();
			} catch (error) {
				toast.error(dict?.mailbox?.actionFailed ?? "Action failed", {
					description: error instanceof Error ? error.message : undefined,
					position: "bottom-left",
				});
			}
		});
	};

	const markRead = () =>
		runBulk(
			(ids) => markAsRead(ids, mailboxId, markImap, true),
			dict?.mailbox?.markedAsRead ?? "Marked as read",
		);

	const markUnread = () =>
		runBulk(
			(ids) => markAsUnread(ids, mailboxId, markImap, true),
			dict?.mailbox?.markedAsUnread ?? "Marked as unread",
		);

	const starThreads = (starred: boolean) =>
		runBulk(
			(ids) => setStarForThreads(ids, mailboxId, starred, markImap, true),
			starred
				? (dict?.mailbox?.starredSelected ?? "Starred selected threads")
				: (dict?.mailbox?.unstarredSelected ??
						"Removed stars from selected threads"),
		);

	const spamThreads = () =>
		runBulk(
			(ids) => moveToSpam(ids, mailboxId, markImap, true),
			dict?.mailbox?.movedToSpam ?? "Moved to Spam",
		);

	const deleteThreads = () => {
		if (mailboxKind === "trash") {
			runBulk(
				(ids) => deleteForever(ids, mailboxId, markImap, true),
				dict?.mailbox?.threadDeletedForever ?? "Thread deleted forever",
			);
			return;
		}
		runBulk(
			(ids) => moveToTrash(ids, mailboxId, markImap, true),
			dict?.mailbox?.movedToTrash ?? "Messages moved to Trash",
		);
	};

	const emptyTrash = () =>
		runBulk(
			() =>
				deleteForever(null, mailboxId, markImap, true, {
					emptyAll: true,
				}),
			dict?.mailbox?.trashRemoved ?? "Trash removed successfully",
			false,
		);

	const actionButtonClass =
		"inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

	const pathName = usePathname();
	const isOnSnoozedPage = pathName.split("/").includes("snoozed");

	return (
		<>
			<div className="sticky top-0 z-10 flex min-w-0 items-center rounded-t-2xl bg-background/95 px-3 py-2 backdrop-blur">
				{!isOnSnoozedPage && (
					<input
						type="checkbox"
						onChange={(e) => {
							const newSet = new Set(state?.selectedThreadIds ?? []);
							if (e.target.checked) {
								mailboxThreads.forEach((t) => {
									newSet.add(t.threadId);
								});
							} else {
								mailboxThreads.forEach((t) => {
									newSet.delete(t.threadId);
								});
							}
							setState((prev) => ({
								...(prev ?? {}),
								selectedThreadIds: newSet,
							}));
						}}
						checked={isChecked}
						aria-label={dict?.mailbox?.selectAll ?? "Select all"}
						className="h-4 w-4 rounded border-muted-foreground/40"
					/>
				)}

				<div className="flex-1" />

				<div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
					<Tooltip label={dict?.mailbox?.sync ?? "Sync"} withArrow>
						<ActionIcon
							variant="subtle"
							onClick={reload}
							disabled={reloading}
							title={dict?.mailbox?.sync ?? "Sync"}
							aria-label={dict?.mailbox?.sync ?? "Sync"}
							className="h-8 w-8"
						>
							<RotateCw className={reloading ? "animate-spin" : ""} size={16} />
						</ActionIcon>
					</Tooltip>

					<div
						className={clsx(
							"inset-0 flex flex-wrap items-center gap-1 transition-opacity",
							hasSelected
								? "opacity-100"
								: "opacity-0 hidden pointer-events-none",
						)}
					>
						<MoveToFolder
							identityMailboxes={identityMailboxes}
							activeMailbox={activeMailbox}
						/>
						<button
							type="button"
							onClick={deleteThreads}
							disabled={isBusy}
							className={actionButtonClass}
							title={dict?.mailbox?.delete ?? "Delete"}
							aria-label={dict?.mailbox?.delete ?? "Delete"}
						>
							<Trash2 className="h-4 w-4" />
						</button>
						{mailboxKind !== "spam" && (
							<button
								type="button"
								onClick={spamThreads}
								disabled={isBusy}
								className={actionButtonClass}
								title={dict?.mailbox?.markAsSpam ?? "Mark as spam"}
								aria-label={dict?.mailbox?.markAsSpam ?? "Mark as spam"}
							>
								<Ban className="h-4 w-4" />
							</button>
						)}
						<button
							type="button"
							onClick={() => starThreads(true)}
							disabled={isBusy}
							className={actionButtonClass}
							title={dict?.mailbox?.star ?? "Star"}
							aria-label={dict?.mailbox?.star ?? "Star"}
						>
							<Star className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={() => starThreads(false)}
							disabled={isBusy}
							className={actionButtonClass}
							title={dict?.mailbox?.unstar ?? "Unstar"}
							aria-label={dict?.mailbox?.unstar ?? "Unstar"}
						>
							<StarOff className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={markRead}
							disabled={isBusy}
							className={actionButtonClass}
							title={dict?.mailbox?.markRead ?? "Mark read"}
							aria-label={dict?.mailbox?.markRead ?? "Mark read"}
						>
							<MailOpen className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={markUnread}
							disabled={isBusy}
							className={actionButtonClass}
							title={dict?.mailbox?.markAsUnread ?? "Mark as unread"}
							aria-label={dict?.mailbox?.markAsUnread ?? "Mark as unread"}
						>
							<Mail className="h-4 w-4" />
						</button>
					</div>

					<div className="md:hidden">
						{sendableIdentityMailboxes.length > 0 && (
							<MailComposerLauncher
								compact
								publicConfig={publicConfig}
								identityMailboxes={sendableIdentityMailboxes}
							/>
						)}
					</div>
				</div>
			</div>

			{mailboxKind === "trash" && (
				<div
					className={
						"flex p-2 text-sm text-muted-foreground justify-center mb-3  mx-2 rounded items-center"
					}
				>
					<span>
						{dict?.mailbox?.trashRetentionNotice ??
							"Messages that have been in the Trash for more than 30 days will be deleted automatically."}
					</span>
					<AlertDialog>
						<AlertDialogTrigger asChild={true} className={"-mx-2"}>
							<Button variant={"transparent"} disabled={isBusy}>
								{dict?.mailbox?.emptyBinNow ?? "Empty Bin Now"}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									{dict?.mailbox?.emptyBinConfirmTitle ??
										"Are you absolutely sure?"}
								</AlertDialogTitle>
								<AlertDialogDescription>
									{dict?.mailbox?.emptyBinConfirmDescription ??
										"This action cannot be undone. This will permanently delete your account and remove your data from our servers."}
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>
									{dict?.common?.cancel ?? "Cancel"}
								</AlertDialogCancel>
								<AlertDialogAction onClick={emptyTrash}>
									{dict?.mailbox?.continue ?? "Continue"}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			)}
		</>
	);
}

export default MailListHeader;
