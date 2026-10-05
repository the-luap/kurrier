import { CalendarView } from "../../../../../calendar-view";

export default async function Page({
	params,
}: {
	params: Promise<{
		calendarPublicId: string;
		view: string;
		year: string;
		month: string;
		day: string;
	}>;
}) {
	return <CalendarView params={await params} />;
}
