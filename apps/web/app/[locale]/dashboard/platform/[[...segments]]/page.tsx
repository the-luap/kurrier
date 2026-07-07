import { getWorkspacePublicId } from "@/lib/actions/clients";
import { redirect } from "next/navigation";

type RouteParams = {
	locale: string;
	segments?: string[];
};

type SearchParams = Record<string, string | string[] | undefined>;

function encodePathSegment(value: string) {
	return encodeURIComponent(value);
}

function toQueryString(searchParams: SearchParams) {
	const params = new URLSearchParams();

	for (const [key, value] of Object.entries(searchParams)) {
		if (Array.isArray(value)) {
			for (const item of value) params.append(key, item);
			continue;
		}

		if (value != null) params.set(key, value);
	}

	const query = params.toString();
	return query ? `?${query}` : "";
}

export default async function Page({
	params,
	searchParams,
}: {
	params: RouteParams | Promise<RouteParams>;
	searchParams: SearchParams | Promise<SearchParams>;
}) {
	const { locale, segments } = await params;
	const resolvedSearchParams = await searchParams;
	const workspacePublicId = await getWorkspacePublicId();
	const targetSegments = segments?.length ? segments : ["overview"];
	const path = [
		"",
		encodePathSegment(locale),
		"w",
		encodePathSegment(workspacePublicId),
		"dashboard",
		"platform",
		...targetSegments.map(encodePathSegment),
	]
		.filter(Boolean)
		.join("/");

	redirect(`/${path}${toQueryString(resolvedSearchParams)}`);
}
