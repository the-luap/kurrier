"use client";

import { useEffect, useState } from "react";

function formatShort(value: Date) {
	return value.toLocaleString(undefined, {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// Formats a timestamp in the viewer's timezone. Rendering happens after mount
// so the server (in its own timezone) and the client never disagree.
export default function LocalTime({
	value,
	className,
}: {
	value: string | number | Date | null | undefined;
	className?: string;
}) {
	const [label, setLabel] = useState("");
	const time = value ? new Date(value).getTime() : Number.NaN;

	useEffect(() => {
		setLabel(Number.isNaN(time) ? "" : formatShort(new Date(time)));
	}, [time]);

	return (
		<time
			className={className}
			dateTime={Number.isNaN(time) ? undefined : new Date(time).toISOString()}
			suppressHydrationWarning
		>
			{label}
		</time>
	);
}
