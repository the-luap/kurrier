import { CalendarView } from "../../calendar-view";

export default function Page({
	params,
}: {
	params: Promise<{ calendarPublicId: string; view: string }>;
}) {
	return <CalendarView params={params} />;
}
