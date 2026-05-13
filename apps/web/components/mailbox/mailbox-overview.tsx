import Link from "next/link";
import type { ElementType } from "react";
import dayjs from "dayjs";
import {
	Archive,
	Ban,
	FileText,
	Folder,
	Inbox,
	Mail,
	Paperclip,
	Send,
	Trash2,
} from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MailboxThreadEntity } from "@db";
import type { FetchMailboxOverviewResult } from "@/lib/actions/mailbox";
import type { MailboxKind } from "@schema";

const ICON: Record<MailboxKind, ElementType> = {
	inbox: Inbox,
	sent: Send,
	drafts: FileText,
	archive: Archive,
	spam: Ban,
	trash: Trash2,
	outbox: Send,
	custom: Folder,
};

const TITLE: Record<MailboxKind, string> = {
	inbox: "Inbox",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	spam: "Spam",
	trash: "Trash",
	outbox: "Outbox",
	custom: "Mailbox",
};

type MailboxOverviewProps = {
	overview: FetchMailboxOverviewResult;
};

type OverviewMailbox =
	FetchMailboxOverviewResult[number]["mailboxes"][number] & {
		totalThreads: number;
		recentThreads: MailboxThreadEntity[];
	};

function mailboxTitle(mailbox: OverviewMailbox) {
	return mailbox.kind === "custom"
		? (mailbox.name ?? "Mailbox")
		: TITLE[mailbox.kind as MailboxKind];
}

function participantLabel(participants: MailboxThreadEntity["participants"]) {
	const sender = participants?.from?.[0];
	return sender?.n || sender?.e || "Unknown sender";
}

export default function MailboxOverview({ overview }: MailboxOverviewProps) {
	const totalUnread = overview.reduce(
		(sum, entry) =>
			sum +
			entry.mailboxes.reduce(
				(mailboxSum, mailbox) => mailboxSum + Number(mailbox.unreadCount ?? 0),
				0,
			),
		0,
	);
	const mailboxCount = overview.reduce(
		(sum, entry) => sum + entry.mailboxes.length,
		0,
	);

	return (
		<div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
			<div className="flex flex-col gap-2">
				<p className="text-sm font-medium text-muted-foreground">Mail</p>
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">
							Mailbox Overview
						</h1>
						<p className="text-sm text-muted-foreground">
							Alle eingebundenen Postfächer auf einen Blick — ohne
							Sidebar-Sucherei.
						</p>
					</div>
					<div className="flex gap-2 text-sm">
						<Badge variant="outline">{mailboxCount} mailboxes</Badge>
						<Badge variant={totalUnread > 0 ? "default" : "outline"}>
							{totalUnread} unread
						</Badge>
					</div>
				</div>
			</div>

			{overview.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>No mailboxes connected</CardTitle>
						<CardDescription>
							Connect an email identity first, then this dashboard will show its
							mailboxes.
						</CardDescription>
					</CardHeader>
				</Card>
			) : (
				<div className="flex flex-col gap-8">
					{overview.map((entry) => (
						<section key={entry.identity.id} className="flex flex-col gap-3">
							<div className="flex min-w-0 items-center justify-between gap-3">
								<div className="min-w-0">
									<h2
										className="truncate text-base font-semibold"
										title={entry.identity.value}
									>
										{entry.identity.value}
									</h2>
									<p className="text-xs text-muted-foreground">
										{entry.mailboxes.length} folder
										{entry.mailboxes.length === 1 ? "" : "s"}
									</p>
								</div>
								<Link
									href={`/dashboard/mail/${entry.identity.publicId}/inbox`}
									className="shrink-0 text-sm font-medium text-brand hover:underline"
								>
									Open inbox
								</Link>
							</div>

							<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
								{entry.mailboxes.map((mailbox) => {
									const overviewMailbox = mailbox as OverviewMailbox;
									const Icon =
										ICON[overviewMailbox.kind as MailboxKind] ?? Folder;
									const unread = Number(overviewMailbox.unreadCount ?? 0);
									const title = mailboxTitle(overviewMailbox);
									const href = `/dashboard/mail/${entry.identity.publicId}/${overviewMailbox.slug ?? "inbox"}`;

									return (
										<Card key={overviewMailbox.id} className="gap-4 py-4">
											<CardHeader className="px-4">
												<div className="flex min-w-0 items-start justify-between gap-3">
													<Link
														href={href}
														className="flex min-w-0 items-center gap-2"
													>
														<span className="rounded-lg border bg-muted p-2">
															<Icon className="h-4 w-4" />
														</span>
														<span className="min-w-0">
															<CardTitle
																className="truncate text-sm"
																title={title}
															>
																{title}
															</CardTitle>
															<CardDescription className="text-xs">
																{overviewMailbox.totalThreads} threads
															</CardDescription>
														</span>
													</Link>
													{unread > 0 ? (
														<Badge>{unread > 999 ? "999+" : unread}</Badge>
													) : null}
												</div>
											</CardHeader>
											<CardContent className="px-4">
												{overviewMailbox.recentThreads.length > 0 ? (
													<div className="flex flex-col divide-y">
														{overviewMailbox.recentThreads.map((thread) => (
															<Link
																key={`${overviewMailbox.id}:${thread.threadId}`}
																href={`${href}/threads/${thread.threadId}`}
																className="group flex min-w-0 gap-2 py-2 text-sm"
															>
																<Mail
																	className={cn(
																		"mt-0.5 h-4 w-4 shrink-0 text-muted-foreground",
																		thread.unreadCount > 0 && "text-brand",
																	)}
																/>
																<div className="min-w-0 flex-1">
																	<div className="flex min-w-0 items-center gap-1">
																		<span
																			className={cn(
																				"truncate",
																				thread.unreadCount > 0 &&
																					"font-semibold",
																			)}
																		>
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
																	{thread.previewText ? (
																		<p className="truncate text-xs text-muted-foreground/80">
																			{thread.previewText}
																		</p>
																	) : null}
																</div>
															</Link>
														))}
													</div>
												) : (
													<p className="text-sm text-muted-foreground">
														No recent mail.
													</p>
												)}
											</CardContent>
										</Card>
									);
								})}
							</div>
						</section>
					))}
				</div>
			)}
		</div>
	);
}
