import { SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/ui/dashboards/unified/default/app-sidebar";
import type { CalendarState } from "@schema";
import { isSignedIn } from "@/lib/actions/auth";
import CalendarSideBar from "@/components/dashboard/calendars/calendar-side-bar";
import * as React from "react";
import NewEventButton from "@/components/dashboard/calendars/new-event-button";
import { fetchDefaultCalendar, fetchOrganizers } from "@/lib/actions/calendar";
import { getTimeZones } from "@vvo/tzdb";
import { DynamicContextProvider } from "@/hooks/use-dynamic-context";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const [user, defaultCalendar, organizers] = await Promise.all([
		isSignedIn(),
		fetchDefaultCalendar(),
		fetchOrganizers(),
	]);

	const timeZones = getTimeZones({ includeUtc: true });
	const abbr = timeZones.find(
		(tz) => tz.name === defaultCalendar.timezone,
	)?.abbreviation;
	const tzAbbr = abbr ?? "UTC";
	const tzName =
		timeZones.find((tz) => tz.abbreviation === tzAbbr)?.name ?? tzAbbr;
	const initialState: CalendarState = {
		defaultCalendar,
		calendarTzAbbr: tzAbbr,
		calendarTzName: tzName,
		organizers,
	};

	const organizersKey = organizers
		.map((o) => `${o.value}:${o.displayName ?? ""}`)
		.join("|");
	const calendarContextKey = [
		defaultCalendar.id,
		defaultCalendar.timezone,
		organizersKey,
	].join("::");

	return (
		<>
			<DynamicContextProvider
				key={calendarContextKey}
				initialState={initialState}
			>
				<AppSidebar
					user={user}
					sidebarSectionContent={
						<CalendarSideBar defaultCalendar={defaultCalendar} />
					}
					sidebarTopContent={
						<>
							<div className={"-mt-1"}>
								<NewEventButton hideOnMobile={true} />
							</div>
						</>
					}
				/>
				<SidebarInset>{children}</SidebarInset>
			</DynamicContextProvider>
		</>
	);
}
