import path from "node:path";

/**
 * Splits a drive path into decoded segments and rejects anything that could
 * leave its base directory: "." / ".." (also percent-encoded, e.g.
 * "..%2F.."), backslashes and NUL bytes.
 */
export function safePathSegments(p: string): string[] {
	const out: string[] = [];
	for (const raw of String(p || "").split("/")) {
		if (!raw) continue;
		let decoded: string;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			throw new Error("Invalid path");
		}
		// A decoded segment may contain "/" (from %2F): validate each part.
		for (const seg of decoded.split("/")) {
			if (!seg) continue;
			if (
				seg === "." ||
				seg === ".." ||
				seg.includes("\0") ||
				seg.includes("\\")
			) {
				throw new Error("Invalid path");
			}
			out.push(seg);
		}
	}
	return out;
}

/**
 * Absolute file system path of `targetPath` inside `basePath` under `root`;
 * throws when the result would not be strictly inside `root`.
 */
export function resolveLocalDrivePath(
	root: string,
	basePath: string,
	targetPath: string,
): string {
	const rootAbs = path.resolve(root);
	const abs = path.resolve(
		rootAbs,
		...safePathSegments(basePath),
		...safePathSegments(targetPath),
	);
	if (!abs.startsWith(rootAbs + path.sep)) {
		throw new Error("Invalid path");
	}
	return abs;
}
