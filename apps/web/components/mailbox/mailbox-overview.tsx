import type { MailboxThreadEntity } from "@db";
import type { MailboxKind } from "@schema";
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
import Link from "next/link";
import type { ElementType } from "react";
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

const ACCENT: Record<MailboxKind, { card: string; icon: string; dot: string }> =
	{
		inbox: {
			card: "border-l-blue-500/70 hover:bg-blue-50/40 dark:border-l-blue-400/70 dark:hover:bg-blue-950/20",
			icon: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300",
			dot: "bg-blue-500 dark:bg-blue-300",
		},
		sent: {
			card: "border-l-emerald-500/70 hover:bg-emerald-50/40 dark:border-l-emerald-400/70 dark:hover:bg-emerald-950/20",
			icon: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
			dot: "bg-emerald-500 dark:bg-emerald-300",
		},
		drafts: {
			card: "border-l-amber-500/70 hover:bg-amber-50/40 dark:border-l-amber-400/70 dark:hover:bg-amber-950/20",
			icon: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
			dot: "bg-amber-500 dark:bg-amber-300",
		},
		archive: {
			card: "border-l-violet-500/70 hover:bg-violet-50/40 dark:border-l-violet-400/70 dark:hover:bg-violet-950/20",
			icon: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300",
			dot: "bg-violet-500 dark:bg-violet-300",
		},
		spam: {
			card: "border-l-rose-500/70 hover:bg-rose-50/40 dark:border-l-rose-400/70 dark:hover:bg-rose-950/20",
			icon: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300",
			dot: "bg-rose-500 dark:bg-rose-300",
		},
		trash: {
			card: "border-l-red-500/70 hover:bg-red-50/40 dark:border-l-red-400/70 dark:hover:bg-red-950/20",
			icon: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
			dot: "bg-red-500 dark:bg-red-300",
		},
		outbox: {
			card: "border-l-cyan-500/70 hover:bg-cyan-50/40 dark:border-l-cyan-400/70 dark:hover:bg-cyan-950/20",
			icon: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-300",
			dot: "bg-cyan-500 dark:bg-cyan-300",
		},
		custom: {
			card: "border-l-slate-300 hover:bg-slate-50/60 dark:border-l-slate-600 dark:hover:bg-slate-900/50",
			icon: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
			dot: "bg-slate-400 dark:bg-slate-500",
		},
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
		<div className="flex flex-1 flex-col gap-6 bg-gradient-to-b from-primary/5 via-background to-background p-4 dark:from-primary/10 dark:via-background dark:to-background md:p-6">
			<div className="relative overflow-hidden rounded-2xl border bg-card/80 p-4 shadow-sm backdrop-blur-sm dark:bg-card/70 md:p-5">
				<div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-primary to-emerald-500 opacity-80 dark:opacity-70" />
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
						<Badge
							className="border-primary/20 bg-primary/5 text-foreground hover:bg-primary/10 dark:border-primary/30 dark:bg-primary/15"
							variant="outline"
						>
							{mailboxCount} mailboxes
						</Badge>
						<Badge
							variant={totalUnread > 0 ? "default" : "outline"}
							className={cn(
								totalUnread === 0 &&
									"border-primary/20 bg-primary/5 dark:bg-primary/15",
							)}
						>
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
						<section
							key={entry.identity.id}
							className="flex flex-col gap-3 rounded-2xl border bg-card/60 p-3 shadow-sm dark:bg-card/50"
						>
							<div className="flex min-w-0 items-center justify-between gap-3">
								<div className="min-w-0 border-l-4 border-l-primary/60 pl-3 dark:border-l-primary/80">
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
										<Card
											key={overviewMailbox.id}
											className={cn(
												"gap-4 border-l-4 py-4 transition-colors",
												ACCENT[overviewMailbox.kind as MailboxKind].card,
											)}
										>
											<CardHeader className="px-4">
												<div className="flex min-w-0 items-start justify-between gap-3">
													<Link
														href={href}
														className="flex min-w-0 items-center gap-2"
													>
														<span
															className={cn(
																"rounded-lg border p-2",
																ACCENT[overviewMailbox.kind as MailboxKind]
																	.icon,
															)}
														>
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
														<Badge className="bg-primary text-primary-foreground shadow-sm dark:bg-primary dark:text-primary-foreground">
															{unread > 999 ? "999+" : unread}
														</Badge>
													) : null}
												</div>
											</CardHeader>
											<CardContent className="px-4">
												{overviewMailbox.recentThreads.length > 0 ? (
													<div className="flex flex-col divide-y">
														{overviewMailbox.recentThreads.map(
															(thread: MailboxThreadEntity) => (
																<Link
																	key={`${overviewMailbox.id}:${thread.threadId}`}
																	href={`${href}/threads/${thread.threadId}`}
																	className="group flex min-w-0 gap-2 py-2 text-sm"
																>
																	<Mail
																		className={cn(
																			"mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-colors",
																			thread.unreadCount > 0 && "text-brand",
																		)}
																	/>
																	<div className="min-w-0 flex-1">
																		<div className="flex min-w-0 items-center gap-1">
																			{thread.unreadCount > 0 ? (
																				<span
																					className={cn(
																						"h-1.5 w-1.5 shrink-0 rounded-full",
																						ACCENT[
																							overviewMailbox.kind as MailboxKind
																						].dot,
																					)}
																				/>
																			) : null}
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
															),
														)}
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
