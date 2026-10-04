// @ts-nocheck
"use client";

import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { MessageEntity } from "@db";
import { ActionIcon } from "@mantine/core";
import { Ellipsis } from "lucide-react";
import { getMessageAddress } from "@common/mail-client";

const BASE_CSS = `
:host {
  --bg: #ffffff;
  --text: #0f172a;      /* slate-900 */
  --muted: #475569;     /* slate-600 */
  --border: #e5e7eb;    /* gray-200 */
  --quote-bg: #f8fafc;  /* slate-50 */
  --quote-bar: #cbd5e1; /* slate-300 */
  --link: #2563eb;
  color: var(--text);
  display: block;
  color-scheme: light;
}

:host-context(.dark),
:host-context([data-theme="dark"]) {
  --bg: transparent;
  --text: #e5e7eb;      /* neutral-200 */
  --muted: #a1a1aa;     /* zinc-400 */
  --border: #3f3f46;    /* zinc-700 */
  --quote-bg: rgba(39, 39, 42, 0.72);
  --quote-bar: #71717a;
  --link: #93c5fd;
  color-scheme: dark;
}

.email-root {
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol";
  background: var(--bg);
  color: var(--text);
  overflow-wrap: break-word;
  overflow-x: auto;
}

:host-context(.dark) .email-root,
:host-context([data-theme="dark"]) .email-root {
  background: transparent !important;
}

:host-context(.dark) .email-root,
:host-context(.dark) .email-root :where(div, p, span, section, article, table, tbody, thead, tfoot, tr, td, th, ul, ol, li, font, center),
:host-context([data-theme="dark"]) .email-root,
:host-context([data-theme="dark"]) .email-root :where(div, p, span, section, article, table, tbody, thead, tfoot, tr, td, th, ul, ol, li, font, center) {
  background-color: transparent !important;
  background: transparent !important;
  color: var(--text) !important;
  border-color: var(--border) !important;
}

:host-context(.dark) .email-root :where([bgcolor="#ffffff"], [bgcolor="#fff"], [bgcolor="white"]),
:host-context([data-theme="dark"]) .email-root :where([bgcolor="#ffffff"], [bgcolor="#fff"], [bgcolor="white"]) {
  background-color: transparent !important;
}


/* Plain-text bodies keep their line breaks; long URLs may wrap anywhere. */
.email-root .plain-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  margin: 0;
}

.email-root p { margin: 0 0 .85em; }
.email-root p:last-child { margin-bottom: 0; }

.email-root h1, .email-root h2, .email-root h3,
.email-root h4, .email-root h5, .email-root h6 {
  margin: 1.2em 0 .6em; line-height: 1.25; font-weight: 600;
}
.email-root h1 { font-size: 1.375rem; }
.email-root h2 { font-size: 1.25rem; }
.email-root h3 { font-size: 1.125rem; }

.email-root ul, .email-root ol { padding-left: 1.25rem; margin: .5rem 0 .85rem; }
.email-root li { margin: .25rem 0; }

/* Zero specificity so the mail's own link/button colours win. */
:where(.email-root) a { color: var(--link); text-decoration: none; }
:where(.email-root) a:hover { text-decoration: underline; }

.email-root img, .email-root video, .email-root canvas, .email-root svg {
  max-width: 100% !important; height: auto !important;
}

/* Don't restyle layout tables; the root scrolls horizontally if a
   fixed-width newsletter is wider than the pane. */

/* Pre/code */
.email-root pre, .email-root code, .email-root kbd, .email-root samp {
  font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
}
.email-root pre:not(.plain-text) { padding: .75rem; background: color-mix(in srgb, var(--text) 7%, transparent); border-radius: .375rem; overflow: auto; white-space: pre-wrap; }

/* Softer <hr>, and hide a leading one */
.email-root hr {
  border: 0; border-top: 1px solid var(--border);
  margin: 1rem 0; height: 1px; opacity: .7;
}
.email-root > hr:first-child { display: none; }

/* Quoted/reply blocks */
.email-root blockquote,
.email-root blockquote[type="cite"],
.email-root .gmail_quote,
.email-root .gmail_quote_container blockquote,
.email-root .moz-cite-prefix + blockquote,
.email-root blockquote blockquote {
  font-size: 0.92rem !important;
  color: var(--muted) !important;
  background: var(--quote-bg) !important;
  border-left: 3px solid var(--quote-bar) !important;
  margin: .75rem 0 !important;
  padding: .5rem .75rem !important;
}
`;

// Only hide quoted history produced by mail clients when replying, not every
// <blockquote> (newsletters and normal mails use them for real content).
export const QUOTE_SELECTORS = [
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
	".plain-quote",
];

const QUOTE_HIDE_CSS = `
${QUOTE_SELECTORS.map((sel) => `.email-root ${sel}`).join(",\n")} {
  display: none !important;
}
`;

function escapeHtml(value: string) {
	return value.replace(
		/[<>&]/g,
		(c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string,
	);
}

// Convert a plain text body to HTML: keep line breaks, linkify URLs and
// collapse a trailing "> quoted" block so it can be toggled like HTML quotes.
function plainTextToHtml(text: string) {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let quoteStart = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i].trim();
		if (l === "" || l.startsWith(">")) {
			if (l.startsWith(">")) quoteStart = i;
			continue;
		}
		break;
	}
	// Include an "On ... wrote:" attribution line right above the quote.
	if (quoteStart < lines.length && quoteStart > 0) {
		let k = quoteStart - 1;
		while (k > 0 && lines[k].trim() === "") k--;
		if (/wrote:\s*$|schrieb:?\s*$/i.test(lines[k])) quoteStart = k;
	}
	const linkify = (s: string) =>
		escapeHtml(s).replace(
			/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
			(url) => `<a href="${url}">${url}</a>`,
		);
	const body = linkify(lines.slice(0, quoteStart).join("\n"));
	const quote =
		quoteStart < lines.length
			? `<div class="plain-quote">${linkify(lines.slice(quoteStart).join("\n"))}</div>`
			: "";
	return `<pre class="plain-text">${body}${quote}</pre>`;
}

// Full HTML documents lose their <head> (and therefore their <style> blocks)
// when sanitized as a fragment. Pull the styles and the <body> attributes out
// first so newsletters keep their layout.
function prepareHtml(html: string) {
	const styles = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [])
		.map((tag) =>
			// "body"/"html" selectors cannot match inside the shadow root.
			tag.replace(/(^|[\s,}>])(?:html|body)(?=[\s{.,:#[>])/gi, "$1.email-body"),
		)
		.join("");
	const bodyMatch = html.match(/<body\b([^>]*)>([\s\S]*?)(?:<\/body>|$)/i);
	const bodyAttrs = bodyMatch?.[1] ?? "";
	const bodyInner = bodyMatch ? bodyMatch[2] : html;
	const bgcolor = bodyAttrs.match(/\bbgcolor\s*=\s*["']?([^"'\s>]+)/i)?.[1];
	const style = bodyAttrs.match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
	const bodyStyle = [style?.[2] ?? style?.[3] ?? "", bgcolor ? `background-color:${bgcolor}` : ""]
		.filter(Boolean)
		.join(";");
	return `${styles}<div class="email-body"${bodyStyle ? ` style="${bodyStyle.replace(/"/g, "&quot;")}"` : ""}>${bodyInner.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")}</div>`;
}

const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi;

// Replace "cid:" references (inline images) with their resolved URLs.
function resolveCids(html: string, cidUrls: Record<string, string>) {
	if (!/cid:/i.test(html)) return html;
	return html.replace(/cid:([^"'()\s>]+)/gi, (match, cid: string) => {
		const url = cidUrls[cid.replace(/^<|>$/g, "").toLowerCase()];
		return url ?? match;
	});
}

export function sanitizeEmail(
	message: Pick<MessageEntity, "html" | "text">,
	{
		cidUrls = {},
		blockRemote = false,
	}: { cidUrls?: Record<string, string>; blockRemote?: boolean } = {},
): { html: string; blockedRemote: number } {
	const html = message.html?.trim() ? message.html : "";
	const rawHtml = html
		? resolveCids(prepareHtml(html), cidUrls)
		: plainTextToHtml(String(message.text || "No content"));

	// Remote images / CSS backgrounds load from the sender's servers and are
	// commonly used as tracking pixels: strip them unless allowed.
	const allowed = new Set(Object.values(cidUrls));
	let blockedRemote = 0;
	const isBlocked = (url: string | null) =>
		!!url && REMOTE_URL.test(url) && !allowed.has(url.trim());
	const hook = (node: Element) => {
		if (!blockRemote || !node.getAttribute) return;
		for (const attr of ["src", "background", "poster"]) {
			if (isBlocked(node.getAttribute(attr))) {
				node.removeAttribute(attr);
				blockedRemote++;
			}
		}
		const srcset = node.getAttribute("srcset");
		if (srcset && /(https?:)?\/\//i.test(srcset)) {
			node.removeAttribute("srcset");
			blockedRemote++;
		}
		const style = node.getAttribute("style");
		if (style) {
			const stripped = style.replace(CSS_REMOTE_URL, "none");
			if (stripped !== style) {
				node.setAttribute("style", stripped);
				blockedRemote++;
			}
		}
		if (node.nodeName === "STYLE" && node.textContent) {
			const css = node.textContent;
			const stripped = css.replace(CSS_REMOTE_URL, "none");
			if (stripped !== css) {
				node.textContent = stripped;
				blockedRemote++;
			}
		}
	};

	DOMPurify.addHook("afterSanitizeAttributes", hook);
	try {
		const safe = DOMPurify.sanitize(rawHtml, {
			USE_PROFILES: { html: true },
			// Keep leading <style> blocks inside the fragment instead of hoisting
			// them into a discarded <head>.
			FORCE_BODY: true,
			ADD_TAGS: ["style"],
			ADD_ATTR: ["target"],
			FORBID_TAGS: ["form", "input", "button", "textarea", "select"],
		});
		return { html: safe, blockedRemote };
	} finally {
		DOMPurify.removeHook("afterSanitizeAttributes");
	}
}

const TRUSTED_SENDERS_KEY = "kurrier:trusted-image-senders";

function readTrustedSenders(): string[] {
	try {
		const raw = window.localStorage.getItem(TRUSTED_SENDERS_KEY);
		const list = raw ? JSON.parse(raw) : [];
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

function trustSender(address: string) {
	try {
		const list = new Set(readTrustedSenders());
		list.add(address.toLowerCase());
		window.localStorage.setItem(
			TRUSTED_SENDERS_KEY,
			JSON.stringify(Array.from(list)),
		);
	} catch {}
}

export default function EmailViewer({
	message,
	cidUrls,
}: {
	message: MessageEntity;
	cidUrls?: Record<string, string>;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [hideQuotes, setHideQuotes] = useState(true);

	const senderAddress = getMessageAddress(message, "from")?.toLowerCase() ?? "";
	const [allowRemote, setAllowRemote] = useState(false);
	const [blockedRemote, setBlockedRemote] = useState(0);
	useEffect(() => {
		if (senderAddress && readTrustedSenders().includes(senderAddress)) {
			setAllowRemote(true);
		}
	}, [senderAddress]);

	const [hasQuotes, setHasQuotes] = useState(false);
	const quoteStyleRef = useRef<HTMLStyleElement | null>(null);
	const hideQuotesRef = useRef(hideQuotes);
	hideQuotesRef.current = hideQuotes;

	// Sanitize/render once per message (DOMPurify needs the browser DOM);
	// toggling quotes only swaps a stylesheet instead of re-rendering.
	const { html, text } = message;
	useEffect(() => {
		if (!hostRef.current) return;
		const result = sanitizeEmail(
			{ html, text },
			{ cidUrls, blockRemote: !allowRemote },
		);
		const safeHtml = result.html;
		setBlockedRemote(result.blockedRemote);

		let shadow = hostRef.current.shadowRoot;
		if (!shadow) shadow = hostRef.current.attachShadow({ mode: "open" });

		shadow.innerHTML = `<style>${BASE_CSS}</style><style data-quotes></style><article class="email-root">${safeHtml}</article>`;
		quoteStyleRef.current = shadow.querySelector("style[data-quotes]");

		const root = shadow.querySelector(".email-root") as HTMLElement | null;
		if (root) {
			for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
				const href = a.getAttribute("href") || "";
				if (href.startsWith("#")) continue;
				a.target = "_blank";
				a.rel = "nofollow noopener noreferrer";
			}
			const quoteSelector = QUOTE_SELECTORS.join(",");
			let canCollapse = false;
			if (root.querySelector(quoteSelector)) {
				// Never collapse everything: if nothing remains once the quotes
				// are removed (e.g. a bare forward), keep the quotes visible.
				const clone = root.cloneNode(true) as HTMLElement;
				for (const node of clone.querySelectorAll(`${quoteSelector},style`))
					node.remove();
				canCollapse =
					(clone.textContent ?? "").trim().length > 0 ||
					clone.querySelector("img") !== null;
			}
			setHasQuotes(canCollapse);
			if (quoteStyleRef.current) {
				quoteStyleRef.current.textContent =
					hideQuotesRef.current && canCollapse ? QUOTE_HIDE_CSS : "";
			}
		}
	}, [html, text, cidUrls, allowRemote]);

	useEffect(() => {
		if (quoteStyleRef.current) {
			quoteStyleRef.current.textContent =
				hideQuotes && hasQuotes ? QUOTE_HIDE_CSS : "";
		}
	}, [hideQuotes, hasQuotes]);

	return (
		<div className="mb-24 mt-6 overflow-x-hidden">
			{blockedRemote > 0 && !allowRemote && (
				<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					<span>Remote images are hidden to protect your privacy.</span>
					<button
						type="button"
						className="font-medium text-foreground hover:underline"
						onClick={() => setAllowRemote(true)}
					>
						Show images
					</button>
					{senderAddress && (
						<button
							type="button"
							className="font-medium text-foreground hover:underline"
							onClick={() => {
								trustSender(senderAddress);
								setAllowRemote(true);
							}}
						>
							Always show from {senderAddress}
						</button>
					)}
				</div>
			)}
			<div ref={hostRef} style={{ display: "block", width: "100%" }} />
			{hasQuotes && (
				<ActionIcon
					type="button"
					variant="light"
					size="xs"
					onClick={() => setHideQuotes((v) => !v)}
					className="my-2 px-2 py-1 rounded border text-[12px] text-gray-600 hover:bg-gray-50"
					title={hideQuotes ? "Show previous emails" : "Hide previous emails"}
				>
					<Ellipsis size={16} />
				</ActionIcon>
			)}
		</div>
	);
}
