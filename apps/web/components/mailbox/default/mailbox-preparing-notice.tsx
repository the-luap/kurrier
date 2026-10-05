"use client";

import { Loader2 } from "lucide-react";
import { useOptionalDictionary } from "@/components/providers/dictionary-provider";

/** Shown while a freshly added identity's mailboxes are still being created. */
export default function MailboxPreparingNotice() {
	const dict = useOptionalDictionary();

	return (
		<div className="m-3 flex items-start gap-3 rounded-xl border bg-muted/30 p-4 text-sm sm:m-4">
			<Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
			<div className="min-w-0">
				<p className="font-medium">
					{dict?.mailbox?.mailboxPreparingTitle ??
						"This mailbox is being prepared"}
				</p>
				<p className="mt-1 text-muted-foreground">
					{dict?.mailbox?.mailboxPreparingDescription ??
						"The folders of a new account are still being set up. Refresh this page in a moment."}
				</p>
			</div>
		</div>
	);
}
