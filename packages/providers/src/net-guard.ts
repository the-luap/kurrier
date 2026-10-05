/**
 * Outbound connection guard (SSRF protection) for connections to hosts or
 * URLs that users configure: webhook endpoints, remote vCard photos, SMTP and
 * IMAP servers.
 *
 * - Always blocked: unspecified, link-local (incl. cloud metadata
 *   169.254.169.254 / fd00:ec2::254), Alibaba metadata, multicast, reserved.
 * - Blocked unless `allowPrivate`: loopback, RFC 1918, CGNAT, ULA and other
 *   non-public ranges.
 *
 * Node-only (node:dns / node:net / node:http). Not exported from the package
 * index so that client bundles that import types from "@providers" are not
 * affected; import it from "@providers/net-guard".
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const alwaysBlocked = new net.BlockList();
// IPv4
alwaysBlocked.addSubnet("0.0.0.0", 8, "ipv4");
alwaysBlocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, cloud metadata
alwaysBlocked.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata
alwaysBlocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
alwaysBlocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
// IPv6
alwaysBlocked.addAddress("::", "ipv6");
alwaysBlocked.addSubnet("fe80::", 10, "ipv6"); // link-local
alwaysBlocked.addAddress("fd00:ec2::254", "ipv6"); // AWS metadata (IPv6)
alwaysBlocked.addSubnet("ff00::", 8, "ipv6"); // multicast

const privateRanges = new net.BlockList();
// IPv4
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
privateRanges.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
privateRanges.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
// IPv6
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6"); // unique local
privateRanges.addSubnet("fec0::", 10, "ipv6"); // site-local (deprecated)
privateRanges.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 (may map to private v4)
privateRanges.addSubnet("2002::", 16, "ipv6"); // 6to4 (may embed private v4)

export type AddressPolicy = {
	/** Allow loopback / RFC 1918 / ULA targets (metadata stays blocked). */
	allowPrivate?: boolean;
};

export class OutboundBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboundBlockedError";
	}
}

/** True when connecting to `ip` is not allowed under `policy`. */
export function isBlockedIp(ip: string, policy: AddressPolicy = {}): boolean {
	const family = net.isIP(ip);
	if (family === 0) return true;
	const type = family === 4 ? "ipv4" : "ipv6";
	if (alwaysBlocked.check(ip, type)) return true;
	if (!policy.allowPrivate && privateRanges.check(ip, type)) return true;
	return false;
}

const truthy = (v: string | undefined) =>
	v !== undefined && ["1", "true", "yes"].includes(v.trim().toLowerCase());

/**
 * Policy for HTTP requests to user supplied URLs (webhooks, remote images).
 * Private networks are blocked unless OUTBOUND_ALLOW_PRIVATE_NETWORKS=true.
 */
export function httpOutboundPolicy(): AddressPolicy {
	return { allowPrivate: truthy(process.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS) };
}

/**
 * Policy for user supplied SMTP/IMAP hosts. Self-hosted mail servers on the
 * LAN are common, so private networks stay allowed unless
 * MAIL_HOST_BLOCK_PRIVATE_NETWORKS=true; metadata/link-local is always
 * blocked.
 */
export function mailHostPolicy(): AddressPolicy {
	return {
		allowPrivate: !truthy(process.env.MAIL_HOST_BLOCK_PRIVATE_NETWORKS),
	};
}

function stripBrackets(host: string) {
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Resolves `host` and throws OutboundBlockedError when it is (or resolves
 * to) a blocked address. Use right before a connection that cannot take a
 * custom `lookup` (nodemailer, imapflow). A DNS answer that changes between
 * this check and the connect (rebinding) is not covered; prefer
 * `guardedLookup` where the client supports it.
 */
export async function assertHostAllowed(
	rawHost: string,
	policy: AddressPolicy = {},
): Promise<void> {
	const host = stripBrackets(String(rawHost ?? "").trim());
	if (!host) throw new OutboundBlockedError("Missing host");

	if (net.isIP(host)) {
		if (isBlockedIp(host, policy)) {
			throw new OutboundBlockedError(`Connections to ${host} are not allowed`);
		}
		return;
	}

	let addresses: dns.LookupAddress[];
	try {
		addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
	} catch {
		throw new OutboundBlockedError(`Could not resolve host ${host}`);
	}

	if (!addresses.length || addresses.some((a) => isBlockedIp(a.address, policy))) {
		throw new OutboundBlockedError(`Connections to ${host} are not allowed`);
	}
}

/**
 * `lookup` replacement for http(s).request / net.connect that rejects
 * blocked addresses at connect time (covers DNS rebinding).
 */
export function guardedLookup(policy: AddressPolicy = {}) {
	return (
		hostname: string,
		options: dns.LookupOptions | number | undefined,
		callback: (
			err: NodeJS.ErrnoException | null,
			address: string | dns.LookupAddress[],
			family?: number,
		) => void,
	) => {
		const opts: dns.LookupOptions =
			typeof options === "number" ? { family: options } : { ...(options ?? {}) };
		dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
			if (err) return callback(err, "", 0);
			const list = addresses as dns.LookupAddress[];
			if (!list.length || list.some((a) => isBlockedIp(a.address, policy))) {
				return callback(
					new OutboundBlockedError(`Connections to ${hostname} are not allowed`),
					"",
					0,
				);
			}
			if (opts.all) return callback(null, list);
			callback(null, list[0].address, list[0].family);
		});
	};
}

export type SafeHttpResponse = {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
	/** The response exceeded maxResponseBytes and was cut off (truncateOk). */
	truncated: boolean;
};

/**
 * HTTP(S) request to a user supplied URL: http/https only, blocked
 * addresses rejected at connect time, no redirects followed (3xx is
 * returned as-is), overall timeout and a response size cap.
 */
export function safeHttpRequest(
	rawUrl: string,
	opts: {
		method?: string;
		headers?: Record<string, string>;
		body?: string | Buffer;
		timeoutMs?: number;
		maxResponseBytes?: number;
		/**
		 * On a response larger than maxResponseBytes, stop reading and
		 * resolve with the status and the truncated body (`truncated: true`)
		 * instead of rejecting. For callers that only need the status
		 * (e.g. webhook delivery); leave off when the body must be complete.
		 */
		truncateOk?: boolean;
		policy?: AddressPolicy;
	} = {},
): Promise<SafeHttpResponse> {
	const policy = opts.policy ?? httpOutboundPolicy();
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const maxBytes = opts.maxResponseBytes ?? 10 * 1024 * 1024;

	return new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		const resolve = (value: SafeHttpResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(value);
		};
		const reject = (err: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectPromise(err);
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return reject(new OutboundBlockedError("Invalid URL"));
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return reject(new OutboundBlockedError("Only http(s) URLs are allowed"));
		}
		const headers: Record<string, string> = { ...(opts.headers ?? {}) };
		if (opts.body !== undefined) {
			// Explicit length: no chunked transfer-encoding, which some
			// webhook receivers reject.
			headers["content-length"] = String(Buffer.byteLength(opts.body));
		}
		if (url.username || url.password) {
			// https://user:pass@host/ → Basic auth header (as fetch would do).
			headers.authorization = `Basic ${Buffer.from(
				`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
			).toString("base64")}`;
			url.username = "";
			url.password = "";
		}
		const host = stripBrackets(url.hostname);
		// lookup() is not called for IP literals: check them here.
		if (net.isIP(host) && isBlockedIp(host, policy)) {
			return reject(
				new OutboundBlockedError(`Connections to ${host} are not allowed`),
			);
		}

		const transport = url.protocol === "https:" ? https : http;
		const req = transport.request(
			url,
			{
				method: opts.method ?? "GET",
				headers,
				lookup: guardedLookup(policy) as unknown as typeof dns.lookup,
				// Fresh sockets per request: a keep-alive socket would skip lookup.
				agent: false,
			},
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				const done = (truncated: boolean) =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks),
						truncated,
					});
				res.on("data", (chunk: Buffer) => {
					if (settled) return;
					size += chunk.length;
					if (size > maxBytes) {
						if (opts.truncateOk) {
							// Status is known: stop reading, keep what fits.
							const room = maxBytes - (size - chunk.length);
							if (room > 0) chunks.push(chunk.subarray(0, room));
							done(true);
							res.destroy();
						} else {
							reject(new Error("Response too large"));
							req.destroy();
						}
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => done(false));
				res.on("error", (err) => reject(err));
			},
		);

		timer = setTimeout(() => {
			req.destroy(new Error(`Request timed out after ${timeoutMs} ms`));
		}, timeoutMs);

		req.on("error", (err) => reject(err));

		if (opts.body !== undefined) req.end(opts.body);
		else req.end();
	});
}
