import { Inbox, Mail, Paperclip } from "lucide-react";
import Link from "next/link";
import LocalTime from "@/components/mailbox/local-time";
import SyncAllMailboxesButton from "@/components/mailbox/sync-all-mailboxes-button";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type {
	FetchMailboxOverviewResult,
	MailboxOverviewThread,
} from "@/lib/actions/mailbox";
import type { Dictionary } from "@/lib/dictionaries";
import type { LocaleFormatter } from "@/lib/locale-format";
import { cn } from "@/lib/utils";

type MailboxOverviewProps = {
	overview: FetchMailboxOverviewResult;
	workspacePublicId: string | undefined;
	dict: Dictionary["mailbox"];
	format: LocaleFormatter;
};

function senderLabel(
	participants: MailboxOverviewThread["participants"],
	fallback: string,
) {
	const sender = participants?.from?.[0];
	return sender?.n || sender?.e || fallback;
}

const unreadOf = (entry: FetchMailboxOverviewResult[number]) =>
	entry.inbox?.unreadThreads ?? 0;

export default function MailboxOverview({
	overview,
	workspacePublicId,
	dict,
	format,
}: MailboxOverviewProps) {
	// Accounts with new mail first (most unread first), then by address.
	const accounts = [...overview].sort(
		(a, b) =>
			unreadOf(b) - unreadOf(a) ||
			a.identity.value.localeCompare(b.identity.value),
	);
	const totalUnread = accounts.reduce((sum, entry) => sum + unreadOf(entry), 0);
	const accountsWithNewMail = accounts.filter(
		(entry) => unreadOf(entry) > 0,
	).length;

	return (
		<div className="flex flex-1 flex-col gap-5 bg-gradient-to-b from-primary/5 via-background to-background p-4 md:p-6 dark:from-primary/10 dark:via-background dark:to-background">
			<div className="relative overflow-hidden rounded-2xl border bg-card/80 p-4 shadow-sm backdrop-blur-sm md:p-5 dark:bg-card/70">
				<div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-primary to-blue-300 opacity-80 dark:opacity-70" />
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div className="min-w-0">
						<h2 className="text-2xl font-semibold tracking-tight">
							{dict.overviewTitle}
						</h2>
						<p className="text-sm text-muted-foreground">
							{dict.overviewDescription}
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<Badge
							className="border-primary/20 bg-primary/5 text-foreground hover:bg-primary/10 dark:border-primary/30 dark:bg-primary/15"
							variant="outline"
						>
							{format.message(overview.length, dict.overviewAccountsCount)}
						</Badge>
						<Badge
							variant={totalUnread > 0 ? "default" : "outline"}
							className={cn(
								totalUnread === 0 &&
									"border-primary/20 bg-primary/5 dark:bg-primary/15",
							)}
						>
							{format.message(totalUnread, dict.overviewNewCount)}
						</Badge>
						<SyncAllMailboxesButton disabled={overview.length === 0} />
					</div>
				</div>
			</div>

			{overview.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>{dict.overviewNoAccountsTitle}</CardTitle>
						<CardDescription>{dict.overviewNoAccountsDescription}</CardDescription>
					</CardHeader>
				</Card>
			) : (
				<div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
					{accounts.map(({ identity, inbox }) => {
						const unread = inbox?.unreadThreads ?? 0;
						const href = `/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/${inbox?.slug ?? "inbox"}`;
						const recentThreads = inbox?.recentThreads ?? [];

						return (
							<Card
								key={identity.id}
								className={cn(
									"gap-3 border-l-4 py-4 transition-colors",
									unread > 0
										? "border-l-blue-500/80 bg-blue-50/40 dark:border-l-blue-400/80 dark:bg-blue-950/20"
										: "border-l-border bg-card/60 dark:bg-card/50",
								)}
							>
								<CardHeader className="px-4">
									<div className="flex min-w-0 items-start justify-between gap-3">
										<Link
											href={href}
											prefetch={false}
											className="flex min-w-0 items-center gap-3"
										>
											<span
												className={cn(
													"rounded-lg border p-2",
													unread > 0
														? "border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/50 dark:text-blue-300"
														: "border-border bg-muted/60 text-muted-foreground",
												)}
											>
												<Inbox className="h-4 w-4" />
											</span>
											<span className="min-w-0">
												<CardTitle
													className="truncate text-sm"
													title={identity.value}
												>
													{identity.value}
												</CardTitle>
												<CardDescription className="text-xs">
													{dict.folderInbox}
												</CardDescription>
											</span>
										</Link>
										{unread > 0 ? (
											<Badge
												className="shrink-0 bg-primary text-primary-foreground shadow-sm"
												title={format.message(unread, dict.unreadThreadsCount)}
											>
												{format.message(unread, dict.overviewNewCount)}
											</Badge>
										) : (
											<Badge
												variant="outline"
												className="shrink-0 text-muted-foreground"
											>
												{dict.overviewClear}
											</Badge>
										)}
									</div>
								</CardHeader>
								<CardContent className="px-4">
									{recentThreads.length > 0 ? (
										<div className="flex flex-col divide-y">
											{recentThreads.map((thread) => (
												<Link
													key={`${thread.mailboxId}:${thread.threadId}`}
													href={`${href}/threads/${thread.threadId}`}
													prefetch={false}
													className="group flex min-w-0 gap-2 py-2 text-sm"
												>
													<Mail className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
													<div className="min-w-0 flex-1">
														<div className="flex min-w-0 items-center gap-1">
															<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 dark:bg-blue-300" />
															<span className="truncate font-semibold group-hover:underline">
																{thread.subject || dict.noSubject}
															</span>
															{thread.hasAttachments ? (
																<Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
															) : null}
														</div>
														<p className="truncate text-xs text-muted-foreground">
															{senderLabel(
																thread.participants,
																dict.unknownSender,
															)}{" "}
															· <LocalTime value={thread.lastActivityAt} />
														</p>
													</div>
												</Link>
											))}
										</div>
									) : (
										<p className="text-sm text-muted-foreground">
											{inbox ? dict.overviewNoNewMail : dict.overviewNoInbox}
										</p>
									)}
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}

			{accountsWithNewMail > 0 ? (
				<p className="text-xs text-muted-foreground">
					{format.message(
						accountsWithNewMail,
						dict.overviewAccountsWithNewMail,
					)}
				</p>
			) : null}
		</div>
	);
}
