"use client";
import type { MailboxEntity, MailboxSyncEntity } from "@db";
import { ActionIcon, Button, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
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
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import ComposeMail from "@/components/mailbox/default/compose-mail";
import MoveToFolder from "@/components/mailbox/default/move-to-folder";
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
	type FetchMailboxThreadsResult,
	getDeltaFetchStatus,
	markAsRead,
	markAsUnread,
	moveToSpam,
	moveToTrash,
	revalidateMailbox,
	setStarForThreads,
} from "@/lib/actions/mailbox";

function MailListHeader({
	mailboxThreads,
	mailboxSync,
	publicConfig,
	activeMailbox,
}: {
	mailboxThreads: FetchMailboxThreadsResult;
	publicConfig: PublicConfig;
	activeMailbox: MailboxEntity;
	mailboxSync?: MailboxSyncEntity;
}) {
	const { state, setState } = useDynamicContext<{
		selectedThreadIds: Set<string>;
		activeMailbox?: MailboxEntity | null;
		identityPublicId: string;
	}>();

	const identityIdRef = useRef<string | undefined>(activeMailbox?.identityId);
	const mailboxIdRef = useRef<string | undefined>(activeMailbox?.id);
	const mailboxKind = activeMailbox?.kind;
	useEffect(() => {
		if (activeMailbox?.identityId)
			identityIdRef.current = activeMailbox.identityId;
		if (activeMailbox?.id) mailboxIdRef.current = activeMailbox.id;
	}, [activeMailbox?.identityId, activeMailbox?.id]);

	const selectedSize = state?.selectedThreadIds?.size ?? 0;
	const hasSelected = selectedSize > 0;
	const isChecked =
		selectedSize === mailboxThreads.length && mailboxThreads.length > 0;

	const [reloading, setReloading] = useState(false);
	const router = useRouter();
	const reload = async () => {
		if (mailboxSync) {
			const identityId = identityIdRef.current;
			if (!identityId) return;
			const toastId = toast.loading("Starting sync…", {
				position: "bottom-left",
			});
			try {
				setReloading(true);
				const result = await deltaFetch({ identityId });
				if (!result.success || !result.jobId) {
					toast.error(result.error ?? "Could not start sync.", {
						id: toastId,
						position: "bottom-left",
					});
					return;
				}
				toast.loading("Sync running in the background…", {
					id: toastId,
					position: "bottom-left",
				});

				let finalState: string = String(result.state);
				let finalError: string | null = null;
				for (let attempt = 0; attempt < 30; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 2000));
					const status = await getDeltaFetchStatus({ jobId: result.jobId });
					finalState = status.state;
					finalError = status.error ?? null;

					if (status.state === "completed") {
						toast.success("Sync completed", {
							id: toastId,
							position: "bottom-left",
						});
						await revalidateMailbox("/mail");
						router.refresh();
						return;
					}

					if (status.state === "failed") {
						toast.error(`Sync failed${finalError ? `: ${finalError}` : ""}`, {
							id: toastId,
							position: "bottom-left",
						});
						return;
					}
				}

				toast.info(`Sync still running in the background (${finalState})`, {
					id: toastId,
					position: "bottom-left",
				});
				await revalidateMailbox("/mail");
				router.refresh();
			} catch (error) {
				toast.error(
					`Could not start or check sync: ${error instanceof Error ? error.message : String(error)}`,
					{ id: toastId, position: "bottom-left" },
				);
			} finally {
				setReloading(false);
			}
		} else {
			await revalidateMailbox("/mail");
			router.refresh();
			toast.success("Mailbox refreshed", { position: "bottom-left" });
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
	// instead of an unhandled rejection.
	const runBulk = (
		action: () => Promise<unknown>,
		successMessage: string,
		errorMessage: string,
	) => {
		startBusy(async () => {
			try {
				await action();
				toast.success(successMessage, { position: "bottom-left" });
				clearSelection();
				router.refresh();
			} catch (error) {
				toast.error(errorMessage, {
					description: error instanceof Error ? error.message : undefined,
					position: "bottom-left",
				});
			}
		});
	};

	const mailboxId = () => String(mailboxIdRef.current);

	const markRead = () =>
		runBulk(
			() => markAsRead(selectedThreads(), mailboxId(), !!mailboxSync, true),
			"Marked selected threads as read",
			"Could not mark threads as read",
		);

	const markUnread = () =>
		runBulk(
			() => markAsUnread(selectedThreads(), mailboxId(), !!mailboxSync, true),
			"Marked selected threads as unread",
			"Could not mark threads as unread",
		);

	const starThreads = (starred: boolean) =>
		runBulk(
			() =>
				setStarForThreads(
					selectedThreads(),
					mailboxId(),
					starred,
					!!mailboxSync,
					true,
				),
			starred
				? "Starred selected threads"
				: "Removed stars from selected threads",
			starred ? "Could not star threads" : "Could not remove stars",
		);

	const spamThreads = () =>
		runBulk(
			() => moveToSpam(selectedThreads(), mailboxId(), !!mailboxSync, true),
			"Selected threads moved to Spam",
			"Could not move threads to Spam",
		);

	const deleteThreads = () => {
		if (mailboxKind === "trash") {
			runBulk(
				() =>
					deleteForever(selectedThreads(), mailboxId(), !!mailboxSync, true),
				"Thread deleted forever",
				"Could not delete threads",
			);
			return;
		}
		runBulk(
			() => moveToTrash(selectedThreads(), mailboxId(), !!mailboxSync, true),
			"Messages moved to Trash",
			"Could not move threads to Trash",
		);
	};

	const emptyTrash = () =>
		runBulk(
			() =>
				deleteForever(null, mailboxId(), !!mailboxSync, true, {
					emptyAll: true,
				}),
			"Trash emptied",
			"Could not empty Trash",
		);

	const isMobile = useMediaQuery("(max-width: 768px)");
	const pathName = usePathname();
	const isOnSnoozedPage = pathName.split("/").includes("snoozed");

	return (
		<>
			<div className="sticky top-0 z-10 flex items-center bg-background/95 px-3 py-2 backdrop-blur rounded-t-2xl">
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
						aria-label="Select all"
						className="h-4 w-4 rounded border-muted-foreground/40"
					/>
				)}

				<div className="flex-1" />

				<div className="flex items-center gap-2 ml-auto">
					<Tooltip label="Sync" withArrow>
						<ActionIcon
							variant="subtle"
							onClick={reload}
							disabled={reloading}
							title="Sync"
							className="h-8 w-8"
						>
							<RotateCw className={reloading ? "animate-spin" : ""} size={16} />
						</ActionIcon>
					</Tooltip>

					<div
						className={clsx(
							"inset-0 flex items-center gap-1 transition-opacity",
							hasSelected
								? "opacity-100"
								: "opacity-0 hidden pointer-events-none",
						)}
					>
						<MoveToFolder activeMailbox={activeMailbox} />
						<button
							type="button"
							onClick={deleteThreads}
							disabled={isBusy}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
							title="Delete"
						>
							<Trash2 className="h-4 w-4" />
						</button>
						{mailboxKind !== "spam" && (
							<button
								type="button"
								onClick={spamThreads}
								disabled={isBusy}
								className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
								title="Mark as spam"
							>
								<Ban className="h-4 w-4" />
							</button>
						)}
						<button
							type="button"
							onClick={() => starThreads(true)}
							disabled={isBusy}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
							title="Star"
						>
							<Star className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={() => starThreads(false)}
							disabled={isBusy}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
							title="Unstar"
						>
							<StarOff className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={markRead}
							disabled={isBusy}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
							title="Mark read"
						>
							<MailOpen className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={markUnread}
							disabled={isBusy}
							className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
							title="Mark unread"
						>
							<Mail className="h-4 w-4" />
						</button>
					</div>

					{isMobile && <ComposeMail publicConfig={publicConfig} />}
				</div>
			</div>

			{mailboxKind === "trash" && (
				<div
					className={
						"flex p-2 text-sm text-muted-foreground justify-center mb-3  mx-2 rounded items-center"
					}
				>
					<span>
						Messages that have been in the Trash for more than 30 days will be
						deleted automatically.
					</span>
					<AlertDialog>
						<AlertDialogTrigger asChild={true} className={"-mx-2"}>
							<Button variant={"transparent"} disabled={isBusy}>
								Empty Bin Now
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
								<AlertDialogDescription>
									This action cannot be undone. All messages in the Trash will
									be permanently deleted.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction onClick={emptyTrash}>
									Continue
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
