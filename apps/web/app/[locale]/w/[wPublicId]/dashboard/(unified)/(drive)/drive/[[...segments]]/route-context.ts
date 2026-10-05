import { cache } from "react";
import { fetchVolumes, normalizeWithinPath } from "@/lib/actions/drive";

const normalizeBySegmentsKey = cache((key: string) =>
	normalizeWithinPath(JSON.parse(key) as string[]),
);

/**
 * Request-deduplicated route context: the segments layout and page both need
 * it, which previously meant two identical DB lookups per navigation.
 * Keyed by a string because `cache` compares arguments by identity.
 */
export function getDriveRouteContext(segments: string[] | undefined) {
	return normalizeBySegmentsKey(JSON.stringify(segments ?? []));
}

/** Request-deduplicated volume list (drive layout + volume picker page). */
export const getDriveVolumes = cache(() => fetchVolumes());
