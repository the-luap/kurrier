import { useSyncExternalStore } from "react";

// The mailbox list stays mounted (hidden) while a thread is open through the
// intercepted @thread route. It publishes the order of the threads it shows
// here, so the thread toolbar can offer Previous/Next without another
// server round trip. When the thread page is opened directly (no list
// mounted) there is no order and the buttons stay disabled.

export const CLOSE_THREAD_EVENT = "kurrier:close-thread";

type ThreadOrder = {
	/** e.g. "/w/<ws>/dashboard/mail/<identity>/<mailbox>/threads/" */
	baseHref: string;
	threadIds: string[];
};

let current: ThreadOrder | null = null;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

export function publishThreadOrder(order: ThreadOrder) {
	if (
		current &&
		current.baseHref === order.baseHref &&
		current.threadIds.length === order.threadIds.length &&
		current.threadIds.every((id, i) => id === order.threadIds[i])
	) {
		return;
	}
	current = order;
	emit();
}

export function clearThreadOrder(baseHref: string) {
	if (current?.baseHref !== baseHref) return;
	current = null;
	emit();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

const getSnapshot = () => current;
const getServerSnapshot = () => null;

export function useAdjacentThreadHrefs(
	threadId: string,
	baseHref: string,
): { previousHref: string | null; nextHref: string | null } {
	const order = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	if (!order || order.baseHref !== baseHref) {
		return { previousHref: null, nextHref: null };
	}
	const index = order.threadIds.indexOf(threadId);
	if (index === -1) return { previousHref: null, nextHref: null };
	const previousId = order.threadIds[index - 1];
	const nextId = order.threadIds[index + 1];
	return {
		previousHref: previousId ? `${order.baseHref}${previousId}` : null,
		nextHref: nextId ? `${order.baseHref}${nextId}` : null,
	};
}
