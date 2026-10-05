import { useSyncExternalStore } from "react";
import type { FetchMailboxThreadsResult } from "@/lib/actions/mailbox";
import type { Dictionary } from "@/lib/dictionaries";

// Shared helpers for the thread list rows. Formatters are created once per
// locale instead of once per row/render (the previous implementation pulled
// in the Temporal polyfill and resolved the timezone for every row).

type ThreadItem = FetchMailboxThreadsResult[number];
type DateInput = string | number | Date | null | undefined;
type MailboxDict = Dictionary["mailbox"] | null | undefined;

type Formatters = {
	time: Intl.DateTimeFormat;
	dayMonth: Intl.DateTimeFormat;
	fullDate: Intl.DateTimeFormat;
	dateTime: Intl.DateTimeFormat;
};

const formatterCache = new Map<string, Formatters>();

function getFormatters(locale: string | undefined): Formatters {
	const key = locale ?? "";
	let formatters = formatterCache.get(key);
	if (!formatters) {
		formatters = {
			time: new Intl.DateTimeFormat(locale, {
				hour: "numeric",
				minute: "2-digit",
			}),
			dayMonth: new Intl.DateTimeFormat(locale, {
				month: "short",
				day: "numeric",
			}),
			fullDate: new Intl.DateTimeFormat(locale, {
				month: "short",
				day: "numeric",
				year: "numeric",
			}),
			dateTime: new Intl.DateTimeFormat(locale, {
				dateStyle: "medium",
				timeStyle: "short",
			}),
		};
		formatterCache.set(key, formatters);
	}
	return formatters;
}

export function toDate(input: DateInput): Date | null {
	if (input === null || input === undefined || input === "") return null;
	const date = input instanceof Date ? input : new Date(input);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Short date/time in the viewer's timezone ("Mar 4, 2025, 3:04 PM"). */
export function formatDateTime(input: DateInput, locale?: string): string {
	const date = toDate(input);
	return date ? getFormatters(locale).dateTime.format(date) : "";
}

/** "3:04 PM" for today, "Mar 4" for this year, "Mar 4, 2023" otherwise. */
export function formatThreadDate(
	input: DateInput,
	locale?: string,
	now = new Date(),
): string {
	const date = toDate(input);
	if (!date) return "";
	const formatters = getFormatters(locale);
	if (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	) {
		return formatters.time.format(date);
	}
	if (date.getFullYear() === now.getFullYear()) {
		return formatters.dayMonth.format(date);
	}
	return formatters.fullDate.format(date);
}

/** "5d ago", "3h ago", "12m ago" or "just now" (translated). */
export function formatRelative(
	input: DateInput,
	dict: MailboxDict,
	now = Date.now(),
): string {
	const date = toDate(input);
	if (!date) return "";
	const diffMinutes = Math.floor(Math.abs(now - date.getTime()) / 60_000);
	const days = Math.floor(diffMinutes / (60 * 24));
	const hours = Math.floor(diffMinutes / 60) % 24;
	const minutes = diffMinutes % 60;
	const prefix = dict?.agoPrefix ?? "";
	if (days >= 1) return `${prefix}${days}${dict?.daysAbbr ?? "d ago"}`;
	if (hours >= 1) return `${prefix}${hours}${dict?.hoursAbbr ?? "h ago"}`;
	if (minutes >= 1) return `${prefix}${minutes}${dict?.minutesAbbr ?? "m ago"}`;
	return dict?.justNow ?? "just now";
}

export type ThreadTimeLabel = {
	text: string;
	className: string;
	title: string;
};

const SNOOZE_BACK_WINDOW_MS = 60 * 60 * 1000;

export function getThreadTimeLabel(
	item: Pick<ThreadItem, "snoozedUntil" | "unsnoozedAt" | "lastActivityAt">,
	dict: MailboxDict,
	locale?: string,
): ThreadTimeLabel {
	const now = Date.now();

	const snoozedUntil = toDate(item.snoozedUntil);
	if (snoozedUntil && snoozedUntil.getTime() > now) {
		return {
			text: dict?.snoozed ?? "Snoozed",
			className: "text-sm text-orange-400",
			title: `${dict?.snoozedUntilPrefix ?? "Snoozed until "}${formatDateTime(snoozedUntil, locale)}`,
		};
	}

	const unsnoozedAt = toDate(item.unsnoozedAt);
	if (unsnoozedAt) {
		const ageMs = now - unsnoozedAt.getTime();
		if (ageMs >= 0 && ageMs <= SNOOZE_BACK_WINDOW_MS) {
			return {
				text: `${dict?.snoozedBackPrefix ?? "Snoozed back "}${formatRelative(unsnoozedAt, dict, now)}`,
				className: "text-sm text-orange-400",
				title: `${dict?.returnedFromSnoozePrefix ?? "Returned from snooze "}${formatDateTime(unsnoozedAt, locale)}`,
			};
		}
	}

	return {
		text: formatThreadDate(item.lastActivityAt || now, locale, new Date(now)),
		className: "text-sm text-foreground",
		title: formatDateTime(item.lastActivityAt || now, locale),
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

const subscribeNoop = () => () => {};

/**
 * false during SSR and hydration, true afterwards. Lets components render
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
