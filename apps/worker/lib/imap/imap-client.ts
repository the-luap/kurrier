import { db, decryptAdminSecrets, identities, smtpAccountSecrets } from "@db";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";

const retryCounts = new Map<string, number>();
const MAX_RETRIES = 3;

// Clients closed on purpose (shutdown, stop-idle) must not auto-reconnect.
const intentionallyClosed = new WeakSet<ImapFlow>();

// In-flight connects per instance map + identity, so concurrent callers share
// one connection instead of each opening (and leaking) their own.
const pendingConnects = new WeakMap<
	Map<string, ImapFlow>,
	Map<string, Promise<ImapFlow | undefined>>
>();

// Called after safeReconnect() re-established a client for a map (used by
// the realtime IDLE sync to re-attach its listeners to the new client).
const reconnectHandlers = new WeakMap<
	Map<string, ImapFlow>,
	(identityId: string, client: ImapFlow) => void | Promise<void>
>();

export function onImapReconnect(
	imapInstances: Map<string, ImapFlow>,
	handler: (identityId: string, client: ImapFlow) => void | Promise<void>,
) {
	reconnectHandlers.set(imapInstances, handler);
}

/** Logs out a client without triggering the automatic reconnect. */
export async function closeImapClient(client: ImapFlow) {
	intentionallyClosed.add(client);
	await client.logout();
}

function safeReconnect(
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) {
	const currentRetries = retryCounts.get(identityId) ?? 0;

	if (currentRetries >= MAX_RETRIES) {
		console.error(`[IMAP:${identityId}] Max retries reached. Giving up.`);
		return;
	}

	retryCounts.set(identityId, currentRetries + 1);

	const existing = imapInstances.get(identityId);
	if (existing) {
		intentionallyClosed.add(existing);
		existing.logout().catch(() => {});
		imapInstances.delete(identityId);
	}

	setTimeout(() => {
		initSmtpClient(identityId, imapInstances)
			.then(async (client) => {
				const handler = reconnectHandlers.get(imapInstances);
				if (client && handler) await handler(identityId, client);
			})
			.catch(console.error);
	}, 5000);
}

export const initSmtpClient = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
): Promise<ImapFlow | undefined> => {
	// If we already have a working connection, reuse it
	try {
		const existing = imapInstances.get(identityId);
		if (existing && existing.authenticated && existing.usable) {
			return existing;
		}
	} catch (err) {
		console.error(`[IMAP:${identityId}] Existing instance check failed`, err);
		safeReconnect(identityId, imapInstances);
		return;
	}

	let pending = pendingConnects.get(imapInstances);
	if (!pending) {
		pending = new Map();
		pendingConnects.set(imapInstances, pending);
	}
	const inFlight = pending.get(identityId);
	if (inFlight) return inFlight;

	const connecting = connectClient(identityId, imapInstances).finally(() => {
		pending.delete(identityId);
	});
	pending.set(identityId, connecting);
	return connecting;
};

async function connectClient(
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
): Promise<ImapFlow | undefined> {
	try {
		const [identity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, identityId));

		if (!identity || !identity.smtpAccountId) {
			return;
		}

		const [secrets] = await decryptAdminSecrets({
			linkTable: smtpAccountSecrets,
			foreignCol: smtpAccountSecrets.accountId,
			secretIdCol: smtpAccountSecrets.secretId,
			ownerId: identity.ownerId,
			parentId: String(identity.smtpAccountId),
		});

		const credentials = secrets?.vault?.decrypted_secret
			? JSON.parse(secrets.vault.decrypted_secret)
			: {};

		const client = new ImapFlow({
			host: credentials.IMAP_HOST,
			port: credentials.IMAP_PORT,
			secure:
				credentials.IMAP_SECURE === "true" || credentials.IMAP_SECURE === true,
			auth: {
				user: credentials.IMAP_USERNAME,
				pass: credentials.IMAP_PASSWORD,
			},
			logger: {
				error(data: any) {
					console.error(`[IMAP:${identityId}]`, data.msg ?? data);
				},
				warn() {},
				info() {},
				debug() {},
			},
			logRaw: false,
		});

		try {
			await client.connect();
		} catch (err) {
			console.error(`[IMAP:${identityId}] connect() failed:`, err);
			safeReconnect(identityId, imapInstances);
			return;
		}

		// A successful connect resets the retry budget; otherwise an identity
		// would stop reconnecting for good after three drops over its lifetime.
		retryCounts.delete(identityId);
		imapInstances.set(identityId, client);

		const noopInterval = setInterval(
			async () => {
				try {
					if (client.usable) {
						await client.noop();
					}
				} catch (err) {
					console.error(`[IMAP:${identityId}] NOOP failed:`, err);
				}
			},
			5 * 60 * 1000,
		);

		let cleanedUp = false;
		const cleanup = (reason: string) => {
			// "error" is usually followed by "close": reconnect only once.
			if (cleanedUp) return;
			cleanedUp = true;
			clearInterval(noopInterval);
			// Only drop the map entry if it still points at this client.
			if (imapInstances.get(identityId) === client) {
				imapInstances.delete(identityId);
			}

			if (intentionallyClosed.has(client)) return;

			console.warn(
				`[IMAP:${identityId}] Disconnected (${reason}), reconnecting...`,
			);
			safeReconnect(identityId, imapInstances);
		};

		client.once("close", () => cleanup("close"));
		// `on`, not `once`: a second "error" without a listener would crash the
		// process.
		client.on("error", (err) => {
			console.error(`[IMAP:${identityId}] Error:`, err);
			cleanup("error");
		});

		return client;
	} catch (err) {
		console.error(`[IMAP:${identityId}] init failed`, err);
		safeReconnect(identityId, imapInstances);
		return;
	}
}
