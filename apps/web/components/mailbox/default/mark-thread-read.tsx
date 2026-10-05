"use client";

import { useEffect, useRef } from "react";
import { markAsRead } from "@/lib/actions/mailbox";

/**
 * Marks an opened thread as read once (not once per rendered message).
 * Rendered by the thread page only while the thread has unread messages.
 */
export default function MarkThreadRead({
	threadId,
	mailboxId,
	markSmtp,
}: {
	threadId: string;
	mailboxId: string;
	markSmtp: boolean;
}) {
	const markedRef = useRef<string | null>(null);

	useEffect(() => {
		const key = `${mailboxId}:${threadId}`;
		if (!mailboxId || markedRef.current === key) return;
		markedRef.current = key;
		markAsRead(threadId, mailboxId, markSmtp, true).catch(() => {
			// Not critical: the thread stays unread and is retried next time.
			markedRef.current = null;
		});
	}, [threadId, mailboxId, markSmtp]);

	return null;
}
