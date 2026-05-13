import type { MailboxThreadEntity } from "@db";
import dayjs from "dayjs";
import { Inbox, Mail, Paperclip } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { FetchMailboxOverviewResult } from "@/lib/actions/mailbox";
import { cn } from "@/lib/utils";

type MailboxOverviewProps = {
	overview: FetchMailboxOverviewResult;
};

type OverviewMailbox =
	FetchMailboxOverviewResult[number]["mailboxes"][number] & {
		totalThreads: number;
		recentThreads: MailboxThreadEntity[];
	};

function participantLabel(participants: MailboxThreadEntity["participants"]) {
	const sender = participants?.from?.[0];
	return sender?.n || sender?.e || "Unknown sender";
}

function findInbox(entry: FetchMailboxOverviewResult[number]) {
	return entry.mailboxes.find((mailbox) => mailbox.kind === "inbox") as
		| OverviewMailbox
		| undefined;
}

export default function MailboxOverview({ overview }: MailboxOverviewProps) {
	const accounts = overview.map((entry) => ({
		entry,
		inbox: findInbox(entry),
	}));
	const inboxUnread = accounts.reduce(
		(sum, { inbox }) => sum + Number(inbox?.unreadCount ?? 0),
		0,
	);
	const accountsWithNewMail = accounts.filter(
		({ inbox }) => Number(inbox?.unreadCount ?? 0) > 0,
	).length;

	return (
		<div className="flex flex-1 flex-col gap-5 bg-gradient-to-b from-primary/5 via-background to-background p-4 dark:from-primary/10 dark:via-background dark:to-background md:p-6">
			<div className="relative overflow-hidden rounded-2xl border bg-card/80 p-4 shadow-sm backdrop-blur-sm dark:bg-card/70 md:p-5">
				<div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-primary to-blue-300 opacity-80 dark:opacity-70" />
				<p className="text-sm font-medium text-muted-foreground">Mail</p>
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">
							Inbox overview
						</h1>
						<p className="text-sm text-muted-foreground">
							Kurzer Überblick pro Account — nur Inbox und neue Mails.
						</p>
					</div>
					<div className="flex gap-2 text-sm">
						<Badge
							className="border-primary/20 bg-primary/5 text-foreground hover:bg-primary/10 dark:border-primary/30 dark:bg-primary/15"
							variant="outline"
						>
							{overview.length} accounts
						</Badge>
						<Badge
							variant={inboxUnread > 0 ? "default" : "outline"}
							className={cn(
								inboxUnread === 0 &&
									"border-primary/20 bg-primary/5 dark:bg-primary/15",
							)}
						>
							{inboxUnread} new
						</Badge>
					</div>
				</div>
			</div>

			{overview.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>No accounts connected</CardTitle>
						<CardDescription>
							Connect an email identity first, then this dashboard will show new
							Inbox mail.
						</CardDescription>
					</CardHeader>
				</Card>
			) : (
				<div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
					{accounts.map(({ entry, inbox }) => {
						const unread = Number(inbox?.unreadCount ?? 0);
						const href = `/dashboard/mail/${entry.identity.publicId}/inbox`;
						const recentThreads = (inbox?.recentThreads ?? []).slice(0, 3);

						return (
							<Card
								key={entry.identity.id}
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
													title={entry.identity.value}
												>
													{entry.identity.value}
												</CardTitle>
												<CardDescription className="text-xs">
													Inbox
												</CardDescription>
											</span>
										</Link>
										{unread > 0 ? (
											<Badge className="shrink-0 bg-primary text-primary-foreground shadow-sm dark:bg-primary dark:text-primary-foreground">
												{unread > 999 ? "999+" : unread} new
											</Badge>
										) : (
											<Badge
												variant="outline"
												className="shrink-0 text-muted-foreground"
											>
												clear
											</Badge>
										)}
									</div>
								</CardHeader>
								<CardContent className="px-4">
									{unread > 0 && recentThreads.length > 0 ? (
										<div className="flex flex-col divide-y">
											{recentThreads.map((thread: MailboxThreadEntity) => (
												<Link
													key={`${inbox?.id}:${thread.threadId}`}
													href={`${href}/threads/${thread.threadId}`}
													className="group flex min-w-0 gap-2 py-2 text-sm"
												>
													<Mail className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
													<div className="min-w-0 flex-1">
														<div className="flex min-w-0 items-center gap-1">
															<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 dark:bg-blue-300" />
															<span className="truncate font-semibold">
																{thread.subject || "(no subject)"}
															</span>
															{thread.hasAttachments ? (
																<Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
															) : null}
														</div>
														<p className="truncate text-xs text-muted-foreground">
															{participantLabel(thread.participants)} ·{" "}
															{dayjs(thread.lastActivityAt).format(
																"DD.MM. HH:mm",
															)}
														</p>
													</div>
												</Link>
											))}
										</div>
									) : (
										<p className="text-sm text-muted-foreground">
											{inbox ? "No new Inbox mail." : "No Inbox found."}
										</p>
									)}
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}

			{overview.length > 0 && accountsWithNewMail > 0 ? (
				<p className="text-xs text-muted-foreground">
					{accountsWithNewMail} account{accountsWithNewMail === 1 ? "" : "s"}{" "}
					with new Inbox mail.
				</p>
			) : null}
		</div>
	);
}
