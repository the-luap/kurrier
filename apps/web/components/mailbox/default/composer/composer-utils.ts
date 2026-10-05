import type { Dictionary } from "@/lib/dictionaries";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Executable / script types that mail providers reject (or that are a
// common malware vector). Checked before the upload starts.
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
	"ade",
	"adp",
	"apk",
	"appx",
	"bat",
	"cab",
	"chm",
	"cmd",
	"com",
	"cpl",
	"dll",
	"dmg",
	"exe",
	"hta",
	"ins",
	"iso",
	"jar",
	"js",
	"jse",
	"lib",
	"lnk",
	"mde",
	"msc",
	"msi",
	"msix",
	"msp",
	"mst",
	"pif",
	"ps1",
	"scr",
	"sct",
	"shb",
	"sys",
	"vb",
	"vbe",
	"vbs",
	"vxd",
	"wsc",
	"wsf",
	"wsh",
]);

/** Returns a translated error message, or null when the file may be attached. */
export function validateAttachment(
	file: File,
	dict: Dictionary | null | undefined,
): string | null {
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return (
			dict?.mailbox?.attachmentTooLarge ?? "{name} is larger than 25 MB"
		).replaceAll("{name}", file.name);
	}

	const ext = file.name.includes(".")
		? (file.name.split(".").pop()?.toLowerCase() ?? "")
		: "";

	if (ext && BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)) {
		return (
			dict?.mailbox?.attachmentBlockedType ??
			"{name} has a blocked executable file type"
		).replaceAll("{name}", file.name);
	}

	return null;
}

// Empty paragraphs from the editor ("<p></p>") collapse to zero height in
// most mail clients, so blank lines typed by the user would disappear.
export function toEmailHtml(html: string) {
	return html.trim().replace(/<p([^>]*)><\/p>/g, "<p$1><br></p>");
}
