import { db, decryptAdminSecrets, identities, smtpAccountSecrets } from "@db";
import { assertHostAllowed, mailHostPolicy } from "@providers/net-guard";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";

// In-flight connects per instance map + identity, so concurrent callers share
// one connection instead of each opening one and leaking all but the last
// (the second imapInstances.set() used to overwrite the first client).
const pendingConnects = new WeakMap<
	Map<string, ImapFlow>,
	Map<string, Promise<ImapFlow | undefined>>
>();

export const initSmtpClient = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
): Promise<ImapFlow | undefined> => {
	const existing = imapInstances.get(identityId);

	if (existing?.authenticated && existing?.usable) {
		return existing;
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
	const existing = imapInstances.get(identityId);

	if (existing?.authenticated && existing?.usable) {
		return existing;
	}
	if (existing) {
		imapInstances.delete(identityId);

		try {
			existing.removeAllListeners();
			// Keep a no-op error listener: a late "error" from the closing
			// socket must not become an uncaught exception.
			existing.on("error", () => {});
			existing.close();
		} catch (err) {
			console.warn(
				`[IMAP:${identityId}] Failed to close stale client`,
				err,
			);
		}
	}

	try {
		const [identity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, identityId))
			.limit(1);

		if (!identity?.smtpAccountId) {
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

		// User supplied host: refuse cloud metadata / link-local (and private
		// ranges with MAIL_HOST_BLOCK_PRIVATE_NETWORKS=true).
		await assertHostAllowed(String(credentials.IMAP_HOST ?? ""), mailHostPolicy());

		const client = new ImapFlow({
			host: credentials.IMAP_HOST,
			port: Number(credentials.IMAP_PORT),
			secure:
				credentials.IMAP_SECURE === "true" ||
				credentials.IMAP_SECURE === true,

			auth: {
				user: credentials.IMAP_USERNAME,
				pass: credentials.IMAP_PASSWORD,
			},

			/*
			 * Keep this unchanged for now.
			 *
			 * We'll deal with timeout behavior separately once the
			 * reconnect ownership issue is fixed.
			 */
			socketTimeout: 60_000,

			logger: {
				error(data: any) {
					console.error(
						`[IMAP:${identityId}]`,
						data?.msg ?? data,
					);
				},
				warn(data: any) {
					console.warn(
						`[IMAP:${identityId}]`,
						data?.msg ?? data,
					);
				},
				info() {},
				debug() {},
			},

			logRaw: false,
		});

		/*
		 * Register lifecycle handlers before connecting so we don't
		 * miss an early close/error event.
		 */
		client.once("close", () => {
			/*
			 * Only remove this client if it is still the active client.
			 * A newer connection may already have replaced it.
			 */
			if (imapInstances.get(identityId) === client) {
				imapInstances.delete(identityId);
			}

			console.warn(`[IMAP:${identityId}] Disconnected (close)`);
		});

		// `on`, not `once`: a second "error" event without a listener would
		// crash the process.
		client.on("error", (err) => {
			console.error(`[IMAP:${identityId}] Error:`, err);

			if (imapInstances.get(identityId) === client) {
				imapInstances.delete(identityId);
			}
		});

		try {
			await client.connect();
		} catch (err) {
			console.error(
				`[IMAP:${identityId}] connect() failed:`,
				err,
			);

			if (imapInstances.get(identityId) === client) {
				imapInstances.delete(identityId);
			}

			try {
				client.removeAllListeners();
				client.on("error", () => {});
				client.close();
			} catch {}

			throw err;
		}

		imapInstances.set(identityId, client);

		return client;
	} catch (err) {
		console.error(`[IMAP:${identityId}] init failed`, err);
		throw err;
	}
}
