import "server-only";

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/*
 * Outbound requests to URLs taken from received mail (List-Unsubscribe) must
 * not reach the server's own network: loopback, private ranges, link-local
 * (cloud metadata), CGNAT, multicast and similar. The address check runs in
 * the socket's DNS lookup, so a hostname cannot pass the check and then
 * resolve to an internal address for the actual connection (DNS rebinding).
 */

function ipv4ToInt(ip: string) {
	return (
		ip
			.split(".")
			.map(Number)
			.reduce((acc, part) => (acc << 8) + part, 0) >>> 0
	);
}

const BLOCKED_V4: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

function isBlockedIpv4(ip: string) {
	const value = ipv4ToInt(ip);
	return BLOCKED_V4.some(([base, bits]) => {
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		return (value & mask) === (ipv4ToInt(base) & mask);
	});
}

/** True for addresses an outbound request must never reach. */
export function isPrivateAddress(rawAddress: string) {
	const address = rawAddress.replace(/^\[|\]$/g, "").toLowerCase();
	if (address === "localhost" || address.endsWith(".localhost")) return true;

	const family = isIP(address);
	if (family === 4) return isBlockedIpv4(address);
	if (family === 6) {
		// IPv4-mapped / -compatible / NAT64 addresses embed an IPv4 address.
		const embedded = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
		if (embedded && isIP(embedded) === 4) return isBlockedIpv4(embedded);
		const mapped = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (mapped) {
			const hi = Number.parseInt(mapped[1], 16);
			const lo = Number.parseInt(mapped[2], 16);
			return isBlockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
		}
		return (
			address === "::" ||
			address === "::1" ||
			/^f[cd][0-9a-f]{0,2}:/.test(address) || // fc00::/7 unique local
			/^fe[89ab][0-9a-f]?:/.test(address) || // fe80::/10 link-local
			/^ff[0-9a-f]{0,2}:/.test(address) || // multicast
			address.startsWith("64:ff9b:") ||
			address.startsWith("2001:db8:")
		);
	}
	return false;
}

/** IPv4 dotted form of an IPv4-mapped/-compatible IPv6 address, if any. */
function embeddedIpv4(address: string) {
	const dotted = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (dotted && isIP(dotted) === 4) return dotted;
	const mapped = address.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (mapped) {
		const hi = Number.parseInt(mapped[1], 16);
		const lo = Number.parseInt(mapped[2], 16);
		return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
	}
	return null;
}

const METADATA_HOSTNAMES = new Set([
	"metadata.google.internal",
	"metadata.goog",
	"metadata",
	"instance-data",
]);

/**
 * True for cloud metadata endpoints, link-local and unspecified addresses
 * (and metadata hostnames). For features where LAN targets are legitimate
 * (self-hosted AI, webhooks into the local network) this is the minimum
 * that must still be blocked.
 */
export function isMetadataOrLinkLocalAddress(rawAddress: string) {
	const address = rawAddress.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
	if (METADATA_HOSTNAMES.has(address)) return true;
	const family = isIP(address);
	const v4 = family === 4 ? address : family === 6 ? embeddedIpv4(address) : null;
	if (v4) {
		return (
			v4.startsWith("169.254.") ||
			v4.startsWith("0.") ||
			v4 === "100.100.100.200" // Alibaba Cloud metadata
		);
	}
	if (family === 6) {
		return (
			address === "::" ||
			/^fe[89ab][0-9a-f]?:/.test(address) ||
			address.startsWith("fd00:ec2:")
		);
	}
	return false;
}

/** Parse and validate an http(s) URL from untrusted input. */
export function parseSafeHttpUrl(rawUrl: string) {
	let url: URL;
	try {
		url = new URL(String(rawUrl).trim());
	} catch {
		throw new Error("Invalid URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Unsupported URL protocol");
	}
	if (url.username || url.password) {
		throw new Error("URL must not contain credentials");
	}
	if (isPrivateAddress(url.hostname)) {
		throw new Error("Unsafe host");
	}
	return url;
}

type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number,
) => void;

function safeLookup(
	hostname: string,
	options: { all?: boolean; family?: number } | number,
	callback: LookupCallback,
) {
	const opts = typeof options === "number" ? { family: options } : options;
	dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
		if (err) return callback(err, opts.all ? [] : "");
		const list = addresses as LookupAddress[];
		if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
			const error: NodeJS.ErrnoException = new Error(
				`Unsafe DNS target for ${hostname}`,
			);
			error.code = "EUNSAFEHOST";
			return callback(error, opts.all ? [] : "");
		}
		if (opts.all) return callback(null, list);
		return callback(null, list[0].address, list[0].family);
	});
}

/**
 * POST a small form body to an untrusted URL: no redirects, private targets
 * blocked at connect time, short timeout, response body discarded.
 * Returns the HTTP status code.
 */
export function safeFormPost(
	rawUrl: string,
	body: string,
	{ timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<number> {
	const url = parseSafeHttpUrl(rawUrl);
	const client = url.protocol === "https:" ? https : http;

	return new Promise((resolve, reject) => {
		const req = client.request(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Content-Length": Buffer.byteLength(body),
					"User-Agent": "Kurrier-Unsubscribe/1.0",
				},
				lookup: safeLookup as any,
				timeout: timeoutMs,
			},
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("timeout", () => req.destroy(new Error("Request timed out")));
		req.on("error", reject);
		req.end(body);
	});
}
