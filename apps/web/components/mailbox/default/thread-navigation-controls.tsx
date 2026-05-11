"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@mantine/core";
import { ArrowLeft, ChevronDown, ChevronUp, X } from "lucide-react";

type Props = {
	backHref: string;
	nextHref?: string | null;
	previousHref?: string | null;
	messageCount: number;
};

export default function ThreadNavigationControls({
	backHref,
	nextHref,
	previousHref,
	messageCount,
}: Props) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const tagName = target?.tagName?.toLowerCase();
			if (
				tagName === "input" ||
				tagName === "textarea" ||
				target?.isContentEditable
			) {
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				window.location.href = backHref;
			}

			if ((event.key === "j" || event.key === "ArrowDown") && nextHref) {
				event.preventDefault();
				window.location.href = nextHref;
			}

			if ((event.key === "k" || event.key === "ArrowUp") && previousHref) {
				event.preventDefault();
				window.location.href = previousHref;
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [backHref, nextHref, previousHref]);

	return (
		<div className="sticky top-0 z-20 mb-4 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					component={Link}
					href={backHref}
					variant="subtle"
					size="xs"
					leftSection={<X size={14} />}
				>
					Close
				</Button>
				<Button
					component={Link}
					href={backHref}
					variant="subtle"
					size="xs"
					leftSection={<ArrowLeft size={14} />}
				>
					Back to list
				</Button>
				<span className="text-xs text-muted-foreground">
					{messageCount > 1
						? `${messageCount} messages in this thread`
						: "Single message"}
				</span>
			</div>

			<div className="flex items-center gap-2">
				{previousHref ? (
					<Button
						component={Link}
						href={previousHref}
						variant="outline"
						size="xs"
						leftSection={<ChevronUp size={14} />}
						title="Previous message/thread (k or Up)"
					>
						Previous
					</Button>
				) : (
					<Button
						disabled
						variant="outline"
						size="xs"
						leftSection={<ChevronUp size={14} />}
					>
						Previous
					</Button>
				)}
				{nextHref ? (
					<Button
						component={Link}
						href={nextHref}
						variant="outline"
						size="xs"
						rightSection={<ChevronDown size={14} />}
						title="Next message/thread (j or Down)"
					>
						Next
					</Button>
				) : (
					<Button
						disabled
						variant="outline"
						size="xs"
						rightSection={<ChevronDown size={14} />}
					>
						Next
					</Button>
				)}
			</div>
		</div>
	);
}
