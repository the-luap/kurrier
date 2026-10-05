import React, { useCallback, useSyncExternalStore } from "react";
import { Dayjs } from "dayjs";

/*
 * One shared 10s ticker for every hour box. The week view renders 168 boxes;
 * previously each one owned its own setInterval (re-created whenever its
 * Dayjs props changed identity). Now there is a single interval and each box
 * only re-renders when *its own* indicator position changes.
 */
const TICK_MS = 10_000;
let nowMs = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!timer) {
		nowMs = Date.now();
		timer = setInterval(() => {
			nowMs = Date.now();
			for (const l of listeners) l();
		}, TICK_MS);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};
}

function indicatorPercent(startMs: number, endMs: number): number | null {
	if (nowMs < startMs || nowMs >= endMs) return null;
	const total = endMs - startMs;
	let percent = ((nowMs - startMs) / total) * 100;
	if (!Number.isFinite(percent)) percent = 0;
	return Math.min(100, Math.max(0, percent));
}

const getServerSnapshot = () => null;

function CalendarBoxIndicatorLayer({
	start,
	end,
}: {
	start: Dayjs;
	end: Dayjs;
}) {
	const startMs = start.valueOf();
	const endMs = end.valueOf();
	const getSnapshot = useCallback(
		() => indicatorPercent(startMs, endMs),
		[startMs, endMs],
	);
	const percent = useSyncExternalStore(
		subscribe,
		getSnapshot,
		getServerSnapshot,
	);

	if (percent === null) {
		return <div className="absolute inset-0 z-10 pointer-events-none" />;
	}

	return (
		<div className="absolute inset-0">
			<div className="absolute inset-x-0" style={{ top: `${percent}%` }}>
				<div className="flex items-center">
					<div className="absolute h-3 w-3 rounded-full bg-brand -ml-[6px]" />
					<div className="w-full border border-brand h-0.5 bg-brand" />
				</div>
			</div>
		</div>
	);
}

export default CalendarBoxIndicatorLayer;
