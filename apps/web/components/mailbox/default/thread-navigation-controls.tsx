"use client";

import { ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useTransition } from "react";
import {
	CLOSE_THREAD_EVENT,
	useAdjacentThreadHrefs,
} from "@/components/mailbox/default/thread-navigation-store";
import { useOptionalI18n } from "@/components/providers/dictionary-provider";

type Props = {
	/** The mailbox list the thread was opened from. */
	backHref: string;
	threadId: string;
	messageCount: number;
	/** Server-computed neighbours, used when the client has no list order. */
	fallbackPreviousThreadId?: string | null;
	fallbackNextThreadId?: string | null;
};

function isTypingTarget(target: EventTarget | null) {
	const element = target as HTMLElement | null;
	if (!element) return false;
	const tagName = element.tagName?.toLowerCase();
	return (
		tagName === "input" ||
		tagName === "textarea" ||
		tagName === "select" ||
		element.isContentEditable ||
		element.closest?.("[role='dialog'],[role='menu'],[role='listbox']") !==
			null
	);
}

/**
 * Sticky toolbar above a thread: back to the list (optimistic), Previous /
 * Next thread, and keyboard shortcuts (Esc closes; j / ArrowDown next;
 * k / ArrowUp previous; ignored while typing or inside dialogs/menus).
 */
export default function ThreadNavigationControls({
	backHref,
	threadId,
	messageCount,
	fallbackPreviousThreadId = null,
	fallbackNextThreadId = null,
}: Props) {
	const router = useRouter();
	const i18n = useOptionalI18n();
	const dict = i18n?.dict;
	const format = i18n?.format;
	const [isPending, startTransition] = useTransition();

	const { previousHref, nextHref } = useAdjacentThreadHrefs(
		threadId,
		`${backHref}/threads/`,
		{
			previousThreadId: fallbackPreviousThreadId,
			nextThreadId: fallbackNextThreadId,
		},
	);

	const navigate = useCallback(
		(href: string | null) => {
			if (!href || isPending) return;
			startTransition(() => router.push(href));
		},
		[isPending, router],
	);

	// Optimistic close: show the list and hide the thread right away, then
	// let the route change catch up.
	const closeThread = useCallback(() => {
		if (isPending) return;

		window.dispatchEvent(new CustomEvent(CLOSE_THREAD_EVENT));
		for (const panel of Array.from(
			document.querySelectorAll<HTMLElement>("[data-thread-panel]"),
		)) {
			panel.style.display = "none";
		}
		startTransition(() => router.replace(backHref));
	}, [backHref, isPending, router]);

	// The intercepted @thread slot can keep its last page after a soft
	// navigation back to the list, so the panel may still carry the
	// display:none from an earlier optimistic close: show it again whenever
	// this thread's URL is active.
	const pathname = usePathname();
	useEffect(() => {
		if (!pathname?.endsWith(`/threads/${threadId}`)) return;
		for (const panel of Array.from(
			document.querySelectorAll<HTMLElement>("[data-thread-panel]"),
		)) {
			panel.style.display = "";
		}
	}, [pathname, threadId]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				isTypingTarget(event.target) ||
				// A stale (hidden) panel kept by the @thread slot must not
				// react once the list is showing again.
				!window.location.pathname.endsWith(`/threads/${threadId}`)
			) {
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				closeThread();
				return;
			}

			if ((event.key === "j" || event.key === "ArrowDown") && nextHref) {
				event.preventDefault();
				navigate(nextHref);
				return;
			}

			if ((event.key === "k" || event.key === "ArrowUp") && previousHref) {
				event.preventDefault();
				navigate(previousHref);
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [closeThread, navigate, nextHref, previousHref, threadId]);

	const navButtonClass =
		"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50";
	const subtleClass = `${navButtonClass} text-muted-foreground hover:bg-muted hover:text-foreground`;
	const outlineClass = `${navButtonClass} border border-border bg-background hover:bg-muted`;

	const previousLabel = dict?.mailbox?.previousThread ?? "Previous";
	const nextLabel = dict?.mailbox?.nextThread ?? "Next";

	return (
		<div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur sm:px-4">
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={closeThread}
					disabled={isPending}
					className={subtleClass}
					title={`${dict?.mailbox?.backToList ?? "Back to list"} (Esc)`}
				>
					<ArrowLeft size={14} />
					{dict?.mailbox?.backToList ?? "Back to list"}
				</button>
				<span className="text-xs text-muted-foreground" aria-live="polite">
					{isPending
						? (dict?.mailbox?.loadingEllipsis ?? "Loading…")
						: messageCount > 1
							? (format?.message(
									messageCount,
									dict?.mailbox?.messagesInThreadCount ?? {
										other: "{count} messages in this thread",
									},
								) ?? `${messageCount} messages in this thread`)
							: (dict?.mailbox?.singleMessage ?? "Single message")}
				</span>
			</div>

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => navigate(previousHref)}
					disabled={!previousHref || isPending}
					className={outlineClass}
					title={`${previousLabel} (k / ↑)`}
				>
					<ChevronUp size={14} />
					{previousLabel}
				</button>
				<button
					type="button"
					onClick={() => navigate(nextHref)}
					disabled={!nextHref || isPending}
					className={outlineClass}
					title={`${nextLabel} (j / ↓)`}
				>
					{nextLabel}
					<ChevronDown size={14} />
				</button>
			</div>
		</div>
	);
}
