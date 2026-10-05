import DayGrid from "@/components/dashboard/calendars/day-view";
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
import type { CalendarViewType } from "@schema";

export type CalendarRouteParams = {
	view?: string;
	year?: string;
	month?: string;
	day?: string;
};

/**
 * Shared server loader + renderer for every calendar route
 * (`/calendar`, `/calendar/[id]/[view]` and `/calendar/[id]/[view]/[y]/[m]/[d]`).
 */
export async function CalendarView({
	params,
}: {
	params: CalendarRouteParams;
}) {
	const defaultCalendar = await fetchDefaultCalendar();
	const view: CalendarViewType = (params.view as CalendarViewType) || "week";

	const viewParams = {
		year: params.year ? Number(params.year) : undefined,
		month: params.month ? Number(params.month) : undefined,
		day: params.day ? Number(params.day) : undefined,
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

	if (view === "week") return <WeekGrid {...gridProps} />;
	if (view === "month") return <MonthGrid {...gridProps} />;
	return <DayGrid {...gridProps} />;
}
