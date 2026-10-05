import { CalendarView } from "../../calendar-view";

export default async function Page({
	params,
}: {
	params: Promise<{ calendarPublicId: string; view: string }>;
}) {
	return <CalendarView params={await params} />;
}
