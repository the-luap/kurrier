"use client";

import type { MessageEntity } from "@db";
import { ActionIcon, Button } from "@mantine/core";
import { Ellipsis, EyeOff, ImageOff } from "lucide-react";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import { useOptionalDictionary } from "@/components/providers/dictionary-provider";

const BASE_CSS = `
:host {
	--bg: #ffffff;
	--text: #0f172a;
	--muted: #475569;
	--border: #e5e7eb;
	--quote-bg: #f8fafc;
	--quote-bar: #cbd5e1;
	--link: #2563eb;

	display: block;
	width: 100%;
	color: var(--text);
	color-scheme: light;
}

:host([data-color-scheme="dark"]) {
	--bg: transparent;
	--text: #e5e7eb;
	--muted: #a1a1aa;
	--border: #3f3f46;
	--quote-bg: rgba(39, 39, 42, 0.72);
	--quote-bar: #71717a;
	--link: #93c5fd;

	color-scheme: dark;
}

.email-root {
	position: relative;
	/* Fixed/absolute positioned mail content stays inside the message. */
	contain: layout;
	width: 100%;
	min-width: 0;
	background: var(--bg);
	color: var(--text);
	font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
	overflow-wrap: anywhere;
	word-break: break-word;
}

/* Dark mode: drop the mail's light backgrounds and dark text colours. */
:host([data-color-scheme="dark"]) .email-root,
:host([data-color-scheme="dark"]) .email-root :where(div, p, span, section, article, table, tbody, thead, tfoot, tr, td, th, ul, ol, li, font, center, h1, h2, h3, h4, h5, h6, b, strong, i, em, u) {
	background-color: transparent !important;
	background-image: none !important;
	color: var(--text) !important;
	border-color: var(--border) !important;
}

:host([data-color-scheme="dark"]) .email-root :where([bgcolor]) {
	background-color: transparent !important;
}

.email-root,
.email-root * {
	box-sizing: border-box;
}

.email-root * {
	max-width: 100%;
	overflow-wrap: anywhere;
}

.email-root p {
	margin: 0 0 0.85em;
}

.email-root p:last-child {
	margin-bottom: 0;
}

.email-root h1,
.email-root h2,
.email-root h3,
.email-root h4,
.email-root h5,
.email-root h6 {
	margin: 1.2em 0 0.6em;
	font-weight: 600;
	line-height: 1.25;
}

.email-root h1 {
	font-size: 1.375rem;
}

.email-root h2 {
	font-size: 1.25rem;
}

.email-root h3 {
	font-size: 1.125rem;
}

.email-root h4,
.email-root h5,
.email-root h6 {
	font-size: 1rem;
}

.email-root ul,
.email-root ol {
	margin: 0.5rem 0 0.85rem;
	padding-left: 1.5rem;
}

.email-root li {
	margin: 0.25rem 0;
}

/* Zero specificity so the mail's own link and button colours win. */
:where(.email-root) a {
	color: var(--link);
	text-decoration: none;
	overflow-wrap: anywhere;
}

:where(.email-root) a:hover {
	text-decoration: underline;
}

.email-root img,
.email-root video,
.email-root canvas,
.email-root svg {
	height: auto !important;
	max-width: 100% !important;
}

.email-root img {
	object-fit: contain;
}

.email-root iframe {
	max-width: 100% !important;
}

.email-root table {
	max-width: 100% !important;
}

.email-root td,
.email-root th {
	max-width: 100%;
	overflow-wrap: anywhere;
}

.email-root pre,
.email-root code,
.email-root kbd,
.email-root samp {
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.email-root pre:not(.kurrier-plain-text) {
	max-width: 100%;
	overflow: auto;
	padding: 0.75rem;
	border-radius: 0.375rem;
	background: color-mix(in srgb, var(--text) 7%, transparent);
	white-space: pre-wrap;
	word-break: break-word;
}

.email-root hr {
	height: 1px;
	margin: 1rem 0;
	border: 0;
	border-top: 1px solid var(--border);
	opacity: 0.7;
}

.email-root > hr:first-child {
	display: none;
}

.email-root blockquote,
.email-root blockquote[type="cite"],
.email-root .gmail_quote,
.email-root .gmail_quote_container blockquote,
.email-root .moz-cite-prefix + blockquote,
.email-root blockquote blockquote {
	margin: 0.75rem 0 !important;
	padding: 0.5rem 0.75rem !important;
	border-left: 3px solid var(--quote-bar) !important;
	background: var(--quote-bg) !important;
	color: var(--muted) !important;
	font-size: 0.92rem !important;
}

/* Plain-text bodies keep their line breaks; long URLs may wrap anywhere. */
.email-root .kurrier-plain-text {
	margin: 0;
	font: inherit;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	word-break: break-word;
}
`;

// Only hide quoted history produced by mail clients when replying, not every
// <blockquote> (newsletters and normal mails use them for real content).
const QUOTE_SELECTORS = [
	".gmail_quote",
	".gmail_quote_container",
	"blockquote[type='cite']",
	".moz-cite-prefix",
	".moz-cite-prefix + blockquote",
	".kurrier_quote",
	"#divRplyFwdMsg",
	"#divRplyFwdMsg ~ *",
	"#appendonsend ~ *",
	".yahoo_quoted",
	".protonmail_quote",
	"[data-marker='__QUOTED_TEXT__']",
	".kurrier-plain-quote",
];

const QUOTE_SELECTOR = QUOTE_SELECTORS.join(",");

const QUOTE_HIDE_CSS = `
${QUOTE_SELECTORS.map((selector) => `.email-root ${selector}`).join(",\n")} {
	display: none !important;
}
`;

type PreparedHtml = {
	html: string;
	hasRemoteImages: boolean;
	canCollapseQuotes: boolean;
};

const EMPTY_PREPARED: PreparedHtml = {
	html: "",
	hasRemoteImages: false,
	canCollapseQuotes: false,
};

const escapeText = (value: string) =>
	value.replace(/[<>&"]/g, (character) => {
		const replacements: Record<string, string> = {
			"<": "&lt;",
			">": "&gt;",
			"&": "&amp;",
			'"': "&quot;",
		};

		return replacements[character] ?? character;
	});

// Convert a plain text body to HTML: keep line breaks, linkify URLs and
// collapse a trailing "> quoted" block so it can be toggled like HTML quotes.
function plainTextToHtml(text: string) {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let quoteStart = lines.length;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith(">")) {
			if (line.startsWith(">")) quoteStart = i;
			continue;
		}
		break;
	}

	// Include an "On ... wrote:" attribution line right above the quote.
	if (quoteStart < lines.length && quoteStart > 0) {
		let k = quoteStart - 1;
		while (k > 0 && lines[k].trim() === "") k--;
		if (/(wrote|schrieb|a écrit|escribió|napisał|escreveu|написал):?\s*$/i.test(lines[k])) {
			quoteStart = k;
		}
	}

	const linkify = (value: string) =>
		escapeText(value).replace(
			/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
			(url) => `<a href="${url}">${url}</a>`,
		);

	const body = linkify(lines.slice(0, quoteStart).join("\n"));
	const quote =
		quoteStart < lines.length
			? `<div class="kurrier-plain-quote">${linkify(lines.slice(quoteStart).join("\n"))}</div>`
			: "";

	return `<pre class="kurrier-plain-text">${body}${quote}</pre>`;
}

// Full HTML documents lose their <head> (and therefore their <style> blocks)
// when sanitized as a fragment. Pull the styles and the <body> attributes out
// first so newsletters keep their layout.
function unwrapDocument(html: string) {
	const styles = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [])
		.map((tag) =>
			// "body"/"html" selectors cannot match inside the shadow root.
			tag.replace(
				/(^|[\s,}>])(?:html|body)(?=[\s{.,:#[>])/gi,
				"$1.email-body",
			),
		)
		.join("");

	const bodyMatch = html.match(/<body\b([^>]*)>([\s\S]*?)(?:<\/body>|$)/i);
	const bodyAttrs = bodyMatch?.[1] ?? "";
	const bodyInner = bodyMatch ? bodyMatch[2] : html;
	const bgcolor = bodyAttrs.match(/\bbgcolor\s*=\s*["']?([^"'\s>]+)/i)?.[1];
	const style = bodyAttrs.match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
	const bodyStyle = [
		style?.[2] ?? style?.[3] ?? "",
		bgcolor ? `background-color:${bgcolor}` : "",
	]
		.filter(Boolean)
		.join(";");

	return `${styles}<div class="email-body"${
		bodyStyle ? ` style="${bodyStyle.replace(/"/g, "&quot;")}"` : ""
	}>${bodyInner.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")}</div>`;
}

// Anything the browser would fetch is "remote" except inline data: URIs and
// unresolved cid: references. A plain scheme check is not enough: browsers
// strip tabs/newlines from URLs, accept backslashes as slashes and resolve
// "https:host" or relative paths, so all of those must count as remote too.
const isRemoteUrl = (value: string) => {
	// Drop ASCII control characters and spaces (U+0000-U+0020).
	const url = value.replace(/[^\x21-\uFFFF]/g, "");
	if (!url) return false;
	return !/^(data|cid):/i.test(url);
};

// Decode CSS escapes (\75 rl(...), htt\70 s:...) so they cannot hide a URL
// from the checks below. Escapes that decode to quotes, backslashes,
// parentheses or whitespace stay escaped so string/token boundaries do not
// move.
const decodeCssEscapes = (css: string) =>
	css.replace(
		/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-f]))/gi,
		(sequence, hex: string | undefined, char: string | undefined) => {
			let decoded = char ?? "";
			if (hex) {
				const code = Number.parseInt(hex, 16);
				if (!(code > 0 && code <= 0x10ffff)) return sequence;
				decoded = String.fromCodePoint(code);
			}
			return /^["'\\()\s]$/.test(decoded) ? sequence : decoded;
		},
	);

// The closing parenthesis is optional: an unterminated url( at the end of a
// style is still fetched.
const CSS_URL = /url\(\s*(?:"([^"]*)"?|'([^']*)'?|([^)]*))\s*\)?/gi;
// image-set("…") and @import "…" take plain strings as URLs.
const CSS_URL_STRING = /(image-set\(|@import\b)[^;{}]*/gi;
const CSS_IMPORT = /@import\b[^;]*;?/gi;

/** Returns the CSS with remote URLs removed, or null when it has none. */
function stripCssRemoteUrls(css: string, trustedUrls: Set<string>) {
	if (!/url|image-set|@import|\\/i.test(css)) return null;
	const decoded = decodeCssEscapes(css);
	let found = false;
	const stripped = decoded
		.replace(CSS_IMPORT, () => {
			found = true;
			return "";
		})
		.replace(CSS_URL_STRING, (match) => {
			if (!/["']/.test(match)) return match;
			found = true;
			return "none";
		})
		.replace(CSS_URL, (match, dq?: string, sq?: string, bare?: string) => {
			const url = dq ?? sq ?? bare ?? "";
			if (!isRemoteUrl(url) || trustedUrls.has(url.trim())) return match;
			found = true;
			return "none";
		});
	return found ? stripped : null;
}

const EMPTY_CID_URLS: Record<string, string> = {};

// Replace "cid:" references (inline images) with their signed URLs. Runs
// before sanitizing: DOMPurify drops the cid: scheme.
function resolveCids(html: string, cidUrls: Record<string, string>) {
	if (!/cid:/i.test(html)) return html;
	return html.replace(/cid:([^"'()\s>]+)/gi, (match, cid: string) => {
		let key = cid.replace(/^<|>$/g, "").toLowerCase();
		try {
			key = decodeURIComponent(key);
		} catch {
			// keep the raw id
		}
		return cidUrls[key] ?? match;
	});
}

const hasRemoteSrcset = (value: string, trustedUrls: Set<string>) =>
	value.split(",").some((candidate) => {
		const url = candidate.trim().split(/\s+/)[0] ?? "";
		return isRemoteUrl(url) && !trustedUrls.has(url);
	});

/**
 * Post-processes sanitized HTML: blocks remote images, CSS backgrounds and
 * imports (tracking pixels) unless allowed, hardens links and checks whether
 * there is reply history that can be collapsed without hiding everything.
 */
const prepareHtml = (
	sanitizedHtml: string,
	allowRemoteImages: boolean,
	blockedAlt: string,
	trustedUrls: Set<string>,
): PreparedHtml => {
	// Parse inside <body> so leading <style> elements are not hoisted into
	// the (discarded) <head>.
	const doc = new DOMParser().parseFromString(
		`<!doctype html><html><head></head><body>${sanitizedHtml}</body></html>`,
		"text/html",
	);

	let hasRemoteImages = false;

	for (const element of Array.from(doc.body.querySelectorAll("*"))) {
		for (const attr of ["src", "background", "poster"]) {
			const value = element.getAttribute(attr);
			if (!value || !isRemoteUrl(value) || trustedUrls.has(value.trim())) {
				continue;
			}
			hasRemoteImages = true;
			if (allowRemoteImages) continue;
			element.setAttribute(`data-blocked-${attr}`, value);
			element.removeAttribute(attr);
			if (element.tagName === "IMG" && !element.getAttribute("alt")) {
				element.setAttribute("alt", blockedAlt);
			}
		}

		const srcset = element.getAttribute("srcset");
		if (srcset && hasRemoteSrcset(srcset, trustedUrls)) {
			hasRemoteImages = true;
			if (!allowRemoteImages) {
				element.setAttribute("data-blocked-srcset", srcset);
				element.removeAttribute("srcset");
			}
		}

		const style = element.getAttribute("style");
		if (style) {
			const stripped = stripCssRemoteUrls(style, trustedUrls);
			if (stripped !== null) {
				hasRemoteImages = true;
				if (!allowRemoteImages) element.setAttribute("style", stripped);
			}
		}

		if (element.tagName === "STYLE" && element.textContent) {
			const stripped = stripCssRemoteUrls(element.textContent, trustedUrls);
			if (stripped !== null) {
				hasRemoteImages = true;
				if (!allowRemoteImages) element.textContent = stripped;
			}
		}
	}

	for (const link of Array.from(
		doc.body.querySelectorAll<HTMLAnchorElement>("a[href]"),
	)) {
		const href = link.getAttribute("href")?.trim() ?? "";

		if (/^javascript:/i.test(href)) {
			link.removeAttribute("href");
			continue;
		}

		if (href.startsWith("#")) continue;

		link.target = "_blank";
		link.rel = "nofollow noopener noreferrer";
	}

	// Never collapse everything: if nothing remains once the quotes are
	// removed (e.g. a bare forward), keep the quotes visible.
	let canCollapseQuotes = false;
	if (doc.body.querySelector(QUOTE_SELECTOR)) {
		const clone = doc.body.cloneNode(true) as HTMLElement;
		for (const node of Array.from(
			clone.querySelectorAll(`${QUOTE_SELECTOR},style`),
		)) {
			node.remove();
		}
		canCollapseQuotes =
			(clone.textContent ?? "").trim().length > 0 ||
			clone.querySelector("img") !== null;
	}

	return {
		html: doc.body.innerHTML,
		hasRemoteImages,
		canCollapseQuotes,
	};
};

function subscribeColorScheme(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class", "data-mantine-color-scheme"],
	});
	return () => observer.disconnect();
}

const getIsDark = () =>
	document.documentElement.classList.contains("dark") ||
	document.documentElement.getAttribute("data-mantine-color-scheme") ===
		"dark";

/** Follows the app theme (the `.dark` class on <html>). */
function useIsDarkMode() {
	return useSyncExternalStore(subscribeColorScheme, getIsDark, () => false);
}

export type EmailViewerMessage = Pick<
	MessageEntity,
	"id" | "html" | "text" | "from"
>;

export default function EmailViewer({
	message,
	cidUrls = EMPTY_CID_URLS,
}: {
	message: EmailViewerMessage;
	/** Lower-cased content id -> signed URL of the inline image. */
	cidUrls?: Record<string, string>;
}) {
	const dict = useOptionalDictionary();
	const hostRef = useRef<HTMLDivElement>(null);
	const quoteStyleRef = useRef<HTMLStyleElement | null>(null);
	const isDark = useIsDarkMode();

	const [hideQuotes, setHideQuotes] = useState(true);
	const [showRemoteImages, setShowRemoteImages] = useState(false);
	const [prepared, setPrepared] = useState<PreparedHtml>(EMPTY_PREPARED);

	const senderEmail =
		message?.from?.value?.[0]?.address?.toLowerCase() ?? "unknown";

	const remoteImagePreferenceKey = `kurrier:remote-images:${senderEmail}`;
	const noContent = dict?.mailbox?.noContent ?? "No content";
	const blockedAlt =
		dict?.mailbox?.remoteImageBlocked ?? "Remote image blocked";

	const rawHtml = useMemo(() => {
		if (message.html?.trim()) {
			return resolveCids(unwrapDocument(message.html), cidUrls);
		}

		return plainTextToHtml(String(message.text || noContent));
	}, [message.html, message.text, noContent, cidUrls]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset per message
	useEffect(() => {
		setHideQuotes(true);

		if (senderEmail === "unknown") {
			setShowRemoteImages(false);
			return;
		}

		try {
			setShowRemoteImages(
				localStorage.getItem(remoteImagePreferenceKey) === "true",
			);
		} catch {
			setShowRemoteImages(false);
		}
	}, [message.id, remoteImagePreferenceKey, senderEmail]);

	// Sanitize once per message / image preference. Toggling the quoted
	// history only swaps a stylesheet (see below).
	useEffect(() => {
		let cancelled = false;

		const prepare = async () => {
			try {
				const { default: DOMPurify } = await import("dompurify");

				const sanitized = DOMPurify.sanitize(rawHtml, {
					USE_PROFILES: {
						html: true,
					},
					// Keep leading <style> blocks inside the fragment instead
					// of hoisting them into a discarded <head>.
					FORCE_BODY: true,
					ADD_TAGS: ["style"],
					ADD_ATTR: ["target"],
					FORBID_TAGS: ["form", "input", "button", "textarea", "select"],
				});

				// Our own signed attachment URLs are not tracking pixels.
				const result = prepareHtml(
					sanitized,
					showRemoteImages,
					blockedAlt,
					new Set(Object.values(cidUrls)),
				);

				if (!cancelled) {
					setPrepared(result);
				}
			} catch {
				if (!cancelled) {
					setPrepared({
						html: `<pre class="kurrier-plain-text">${escapeText(
							String(message.text || noContent),
						)}</pre>`,
						hasRemoteImages: false,
						canCollapseQuotes: false,
					});
				}
			}
		};

		void prepare();

		return () => {
			cancelled = true;
		};
	}, [rawHtml, showRemoteImages, message.text, noContent, blockedAlt, cidUrls]);

	useEffect(() => {
		const host = hostRef.current;

		if (!host) {
			return;
		}

		const shadow =
			host.shadowRoot ??
			host.attachShadow({
				mode: "open",
			});

		shadow.innerHTML = `<style>${BASE_CSS}</style><style data-quotes></style><article class="email-root">${prepared.html}</article>`;
		quoteStyleRef.current = shadow.querySelector("style[data-quotes]");
	}, [prepared.html]);

	// Runs after the render effect above (declaration order), so a freshly
	// written shadow root gets the current quote state as well.
	useEffect(() => {
		if (!quoteStyleRef.current) return;
		quoteStyleRef.current.textContent =
			hideQuotes && prepared.canCollapseQuotes ? QUOTE_HIDE_CSS : "";
	}, [hideQuotes, prepared]);

	const allowRemoteImagesForSender = () => {
		if (senderEmail === "unknown") {
			setShowRemoteImages(true);
			return;
		}

		try {
			localStorage.setItem(remoteImagePreferenceKey, "true");
		} catch {
			// Preference persistence is optional.
		}

		setShowRemoteImages(true);
	};

	const quoteToggleLabel = hideQuotes
		? (dict?.mailbox?.showQuotedText ?? "Show previous emails")
		: (dict?.mailbox?.hideQuotedText ?? "Hide previous emails");

	return (
		<div className="mb-24 mt-6 min-w-0 overflow-x-hidden">
			{prepared.hasRemoteImages && !showRemoteImages && (
				<div className="mb-4 flex flex-col gap-3 rounded-lg border bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex min-w-0 items-start gap-3">
						<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
							<ImageOff className="size-4 text-muted-foreground" />
						</div>

						<div className="min-w-0">
							<p className="text-sm font-medium">
								{dict?.mailbox?.remoteImagesBlocked ??
									"Remote images are blocked"}
							</p>

							<p className="mt-0.5 text-xs leading-5 text-muted-foreground">
								{dict?.mailbox?.remoteImagesBlockedDescription ??
									"Images from external servers can be used to track when you open a message."}
							</p>
						</div>
					</div>

					<div className="flex shrink-0 flex-col gap-2 sm:flex-row">
						<Button
							size="xs"
							variant="default"
							onClick={() => setShowRemoteImages(true)}
						>
							{dict?.mailbox?.loadRemoteImagesOnce ?? "Load once"}
						</Button>

						<Button
							size="xs"
							variant="light"
							onClick={allowRemoteImagesForSender}
						>
							{dict?.mailbox?.alwaysLoadForThisSender ?? "Always for sender"}
						</Button>
					</div>
				</div>
			)}

			<div
				ref={hostRef}
				data-color-scheme={isDark ? "dark" : "light"}
				className="block min-w-0 w-full"
			/>

			{prepared.canCollapseQuotes && (
				<div className="mt-3">
					<ActionIcon
						type="button"
						variant="subtle"
						size="sm"
						onClick={() => setHideQuotes((current) => !current)}
						title={quoteToggleLabel}
						aria-label={quoteToggleLabel}
						aria-pressed={!hideQuotes}
					>
						{hideQuotes ? <Ellipsis size={17} /> : <EyeOff size={16} />}
					</ActionIcon>
				</div>
			)}
		</div>
	);
}
