/**
 * Composer uploads are stored under `private/<userId>/<messageId>/<file>`
 * (see createAttachmentUploadUrl). A key is the caller's own only if it is in
 * that folder and cannot escape it.
 */
export function isOwnUploadKey(key: string, userId: string) {
	if (!key || !userId) return false;
	const parts = key.split("/");
	return (
		parts[0] === "private" &&
		parts[1] === userId &&
		parts.length >= 3 &&
		parts
			.slice(2)
			.every((part) => part.length > 0 && part !== "." && part !== "..") &&
		!key.includes("\\")
	);
}
