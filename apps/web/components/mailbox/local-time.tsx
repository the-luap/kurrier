"use client";

import { useIsClient } from "@/components/mailbox/default/thread-list-utils";
import { useOptionalI18n } from "@/components/providers/dictionary-provider";

const SHORT_FORMAT: Intl.DateTimeFormatOptions = {
	day: "2-digit",
	month: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
};

// Formats a timestamp in the viewer's timezone. Rendering happens on the
// client only so the server (in its own timezone) and the client never
// disagree; useIsClient avoids an effect + extra render per instance.
export default function LocalTime({
	value,
	className,
}: {
	value: string | number | Date | null | undefined;
	className?: string;
}) {
	const isClient = useIsClient();
	const format = useOptionalI18n()?.format;
	const time = value ? new Date(value).getTime() : Number.NaN;
	const valid = !Number.isNaN(time);

	return (
		<time
			className={className}
			dateTime={valid ? new Date(time).toISOString() : undefined}
			suppressHydrationWarning
		>
			{isClient && valid
				? (format?.date(time, SHORT_FORMAT) ??
					new Intl.DateTimeFormat(undefined, SHORT_FORMAT).format(time))
				: ""}
		</time>
	);
}
