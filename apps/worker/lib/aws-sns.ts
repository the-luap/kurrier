import { createVerify } from "node:crypto";

const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export type SnsMessage = {
	Type?: string;
	MessageId?: string;
	Token?: string;
	TopicArn?: string;
	Subject?: string;
	Message?: string;
	Timestamp?: string;
	SignatureVersion?: string;
	Signature?: string;
	SigningCertURL?: string;
	SubscribeURL?: string;
	[key: string]: unknown;
};

/** True only for https URLs that point at an AWS SNS endpoint. */
export function isTrustedSnsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			(url.port === "" || url.port === "443") &&
			SNS_HOST_RE.test(url.hostname)
		);
	} catch {
		return false;
	}
}

const certCache = new Map<string, Promise<string>>();

function getSigningCert(url: string): Promise<string> {
	let pending = certCache.get(url);
	if (!pending) {
		pending = fetch(url, { redirect: "error" }).then(async (res) => {
			if (!res.ok) {
				throw new Error(`Failed to fetch SNS signing cert (${res.status})`);
			}
			const pem = await res.text();
			if (!pem.includes("BEGIN CERTIFICATE")) {
				throw new Error("SNS signing cert is not a PEM certificate");
			}
			return pem;
		});
		pending.catch(() => certCache.delete(url));
		certCache.set(url, pending);
	}
	return pending;
}

function canonicalString(msg: SnsMessage): string | null {
	const keys =
		msg.Type === "Notification"
			? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
			: msg.Type === "SubscriptionConfirmation" ||
					msg.Type === "UnsubscribeConfirmation"
				? [
						"Message",
						"MessageId",
						"SubscribeURL",
						"Timestamp",
						"Token",
						"TopicArn",
						"Type",
					]
				: null;
	if (!keys) return null;

	let out = "";
	for (const key of keys) {
		const value = msg[key];
		if (value === undefined || value === null) {
			// Subject is optional for notifications; everything else is required.
			if (key === "Subject") continue;
			return null;
		}
		out += `${key}\n${String(value)}\n`;
	}
	return out;
}

/**
 * Verifies the signature of an SNS HTTP(S) delivery (SignatureVersion 1 =
 * SHA1withRSA, 2 = SHA256withRSA). The signing certificate is only fetched
 * from a validated sns.<region>.amazonaws.com host.
 */
export async function verifySnsMessage(msg: SnsMessage): Promise<boolean> {
	if (!msg || typeof msg !== "object") return false;
	if (!msg.Signature || !isTrustedSnsUrl(msg.SigningCertURL)) return false;
	if (!new URL(msg.SigningCertURL).pathname.endsWith(".pem")) return false;

	const algorithm =
		msg.SignatureVersion === "1"
			? "RSA-SHA1"
			: msg.SignatureVersion === "2"
				? "RSA-SHA256"
				: null;
	if (!algorithm) return false;

	const toSign = canonicalString(msg);
	if (!toSign) return false;

	try {
		const cert = await getSigningCert(msg.SigningCertURL);
		const verifier = createVerify(algorithm);
		verifier.update(toSign, "utf8");
		return verifier.verify(cert, msg.Signature, "base64");
	} catch (err) {
		console.warn("[SNS] Signature verification failed:", err);
		return false;
	}
}
