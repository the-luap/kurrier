import { useSyncExternalStore } from "react";
import type { FetchMailboxThreadsResult } from "@/lib/actions/mailbox";

// Shared helpers for the desktop and mobile thread list rows. Formatters are
// created once per module instead of once per row/render (the previous
// implementation pulled in the Temporal polyfill and resolved the timezone
// for every row).

type ThreadItem = FetchMailboxThreadsResult[number];
type DateInput = string | number | Date | null | undefined;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const dayMonthFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

function toDate(input: DateInput): Date | null {
	if (input === null || input === undefined || input === "") return null;
	const date = input instanceof Date ? input : new Date(input);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** "3:04 PM" for today, "Mar 4" for this year, "Mar 4, 2023" otherwise. */
export function formatThreadDate(input: DateInput, now = new Date()): string {
	const date = toDate(input);
	if (!date) return "";
	if (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	) {
		return timeFormatter.format(date);
	}
	if (date.getFullYear() === now.getFullYear()) {
		return dayMonthFormatter.format(date);
	}
	return fullDateFormatter.format(date);
}

/** "5d ago", "3h ago", "12m ago" or "just now". */
export function formatRelative(input: DateInput, now = Date.now()): string {
	const date = toDate(input);
	if (!date) return "";
	const diffMinutes = Math.floor(Math.abs(now - date.getTime()) / 60_000);
	const days = Math.floor(diffMinutes / (60 * 24));
	const hours = Math.floor(diffMinutes / 60) % 24;
	const minutes = diffMinutes % 60;
	if (days >= 1) return `${days}d ago`;
	if (hours >= 1) return `${hours}h ago`;
	if (minutes >= 1) return `${minutes}m ago`;
	return "just now";
}

export type ThreadTimeLabel = {
	text: string;
	className: string;
	title: string;
};

const SNOOZE_BACK_WINDOW_MS = 60 * 60 * 1000;

export function getThreadTimeLabel(
	item: Pick<ThreadItem, "snoozedUntil" | "unsnoozedAt" | "lastActivityAt">,
): ThreadTimeLabel {
	const now = Date.now();

	const snoozedUntil = toDate(item.snoozedUntil);
	if (snoozedUntil && snoozedUntil.getTime() > now) {
		return {
			text: "Snoozed",
			className: "text-sm text-orange-400",
			title: `Snoozed until ${snoozedUntil.toLocaleString()}`,
		};
	}

	const unsnoozedAt = toDate(item.unsnoozedAt);
	if (unsnoozedAt) {
		const ageMs = now - unsnoozedAt.getTime();
		if (ageMs >= 0 && ageMs <= SNOOZE_BACK_WINDOW_MS) {
			return {
				text: `Snoozed back ${formatRelative(unsnoozedAt, now)}`,
				className: "text-sm text-orange-400",
				title: `Returned from snooze ${unsnoozedAt.toLocaleString()}`,
			};
		}
	}

	return {
		text: formatThreadDate(item.lastActivityAt || now, new Date(now)),
		className: "text-sm text-foreground",
		title: "",
	};
}

/** Up to three unique participant names (from, to, cc, bcc order). */
export function getParticipantNames(
	participants: ThreadItem["participants"],
): string {
	const p = participants;
	const lists = [p?.from ?? [], p?.to ?? [], p?.cc ?? [], p?.bcc ?? []];
	const seen = new Set<string>();
	const names: string[] = [];

	outer: for (const list of lists) {
		for (const x of list) {
			const e = x?.e?.trim();
			if (!e) continue;
			const key = e.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			names.push(x.n?.trim() || e);
			if (names.length > 3) break outer;
		}
	}

	return names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
}

/** Base URL ("…/threads/") for opening a thread from the list. */
export function getThreadBaseHref(
	pathname: string,
	identityPublicId: string,
	mailboxSlug: string | null | undefined,
): string {
	const prefix = pathname.match("/dashboard/mail")
		? "/dashboard/mail"
		: "/mail";
	return `${prefix}/${identityPublicId}/${mailboxSlug}/threads/`;
}

const subscribeNoop = () => () => {};

/**
 * false during SSR and hydration, true afterwards. Lets rows render
 * timezone-dependent labels on the client only, without a per-row
 * useEffect + setState (which costs an extra render for every row).
 */
export function useIsClient(): boolean {
	return useSyncExternalStore(
		subscribeNoop,
		() => true,
		() => false,
	);
}
