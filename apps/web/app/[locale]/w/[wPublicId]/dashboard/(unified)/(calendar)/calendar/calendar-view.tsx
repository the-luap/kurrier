import type { CalendarViewType } from "@schema";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import Loading from "@/app/loading";
import DayGrid from "@/components/dashboard/calendars/day-view";
import DefaultCalendarContext from "@/components/dashboard/calendars/default-calendar-context";
import MonthGrid from "@/components/dashboard/calendars/month-view";
import { WeekGrid } from "@/components/dashboard/calendars/week-view";
import {
	eventsByDayWithAllDay,
	expandEventsForRange,
	fetchCalendarEventsForRange,
	fetchDefaultCalendar,
	fetchEventAttendees,
	getContactsForAttendeeIds,
	getRangeForCalendarView,
} from "@/lib/actions/calendar";
import { getWorkspacePublicId } from "@/lib/actions/clients";

export type CalendarRouteParams = {
	calendarPublicId?: string;
	view?: string;
	year?: string;
	month?: string;
	day?: string;
};

const CALENDAR_VIEWS: CalendarViewType[] = ["day", "week", "month"];

async function CalendarViewContent({
	params,
}: {
	params: Promise<CalendarRouteParams>;
}) {
	await connection();

	const resolvedParams = await params;

	const [defaultCalendar, workspacePublicId] = await Promise.all([
		fetchDefaultCalendar(resolvedParams.calendarPublicId),
		getWorkspacePublicId(),
	]);

	if (!defaultCalendar) notFound();

	const view: CalendarViewType = CALENDAR_VIEWS.includes(
		resolvedParams.view as CalendarViewType,
	)
		? (resolvedParams.view as CalendarViewType)
		: "week";

	const viewParams = {
		year: resolvedParams.year ? Number(resolvedParams.year) : undefined,
		month: resolvedParams.month ? Number(resolvedParams.month) : undefined,
		day: resolvedParams.day ? Number(resolvedParams.day) : undefined,
	};

	const { from, to } = await getRangeForCalendarView(
		defaultCalendar.timezone,
		view,
		viewParams,
	);

	const fromDate = from instanceof Date ? from : from.toDate();
	const toDate = to instanceof Date ? to : to.toDate();

	const events = await fetchCalendarEventsForRange(
		defaultCalendar.id,
		fromDate,
		toDate,
	);

	const expandedEvents = await expandEventsForRange(
		events,
		fromDate,
		toDate,
		defaultCalendar.timezone,
	);

	const masterIds = Array.from(new Set(expandedEvents.map((e) => e.id)));

	// Bucketing and the attendee lookup are independent: run them in parallel.
	const [{ timedByDay, allDayByDay }, attendees] = await Promise.all([
		eventsByDayWithAllDay(defaultCalendar.timezone, expandedEvents),
		fetchEventAttendees(masterIds),
	]);

	const attendeeIds = Object.values(attendees).flatMap((list) =>
		list.map((a) => a.id),
	);
	// Not awaited on purpose: streamed to the client and unwrapped with use().
	const contacts = getContactsForAttendeeIds(attendeeIds);

	const gridProps = {
		events: expandedEvents,
		byDayMap: timedByDay,
		attendees,
		attendeeContacts: contacts,
		allDayByDay,
	};

	return (
		<DefaultCalendarContext defaultCalendar={defaultCalendar}>
			{view === "week" ? (
				<WeekGrid {...gridProps} />
			) : view === "month" ? (
				<MonthGrid {...gridProps} workspacePublicId={workspacePublicId} />
			) : (
				<DayGrid {...gridProps} />
			)}
		</DefaultCalendarContext>
	);
}

/**
 * Shared server loader and renderer for every calendar route
 * (`/calendar`, `/calendar/[id]/[view]` and `/calendar/[id]/[view]/[y]/[m]/[d]`).
 * Previously `/calendar/[id]/[view]` always rendered the day grid and ignored
 * the calendar id.
 */
export function CalendarView({
	params,
}: {
	params: Promise<CalendarRouteParams>;
}) {
	return (
		<Suspense fallback={<Loading />}>
			<CalendarViewContent params={params} />
		</Suspense>
	);
}
