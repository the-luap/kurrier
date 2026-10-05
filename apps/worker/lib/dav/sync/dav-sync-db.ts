import {
	AddressBookEntity,
	addressBooks,
	ContactEntity,
	contacts,
	db,
} from "@db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { davCards, DavCardsEntity, davDb } from "../dav-schema";
import { parseVCardToContact } from "./dav-vcard";
import { nanoid } from "nanoid";
import { davParsePhoto } from "./dav-profile-image";

const fetchContactData = async (card: DavCardsEntity) => {
	const vcardBytes = card.carddata as Uint8Array;
	return Buffer.from(vcardBytes).toString("utf8");
};

const createContact = async ({
	card,
	book,
}: {
	card: DavCardsEntity;
	book: AddressBookEntity;
}) => {
	const parsed = parseVCardToContact(await fetchContactData(card));

	const newContactPublicId = nanoid(10);
	const payload = {
		ownerId: book.ownerId,
		addressBookId: book.id,
		publicId: newContactPublicId,
		...parsed,
	} as ContactEntity;

	await davParsePhoto(parsed, book, newContactPublicId, payload);

	payload.davUri = card.uri;
	payload.davEtag = normalizeEtag(card.etag);

	const [inserted] = await db
		.insert(contacts)
		.values(payload)
		.onConflictDoNothing()
		.returning();
	return inserted;
};

const updateContact = async ({
	card,
	book,
	localContact,
}: {
	card: DavCardsEntity;
	book: AddressBookEntity;
	localContact: ContactEntity;
}) => {
	const parsed = parseVCardToContact(await fetchContactData(card));

	const payload = {
		ownerId: book.ownerId,
		addressBookId: book.id,
		...parsed,
	} as ContactEntity;

	await davParsePhoto(parsed, book, localContact.publicId, payload);

	payload.davUri = card.uri;
	payload.davEtag = normalizeEtag(card.etag);

	const [contact] = await db
		.update(contacts)
		.set(payload)
		.where(eq(contacts.id, localContact.id))
		.returning();

	return contact;
};

const syncBook = async (
	book: AddressBookEntity,
	defaultDavBookId: number | null,
) => {
	const parts = book.remotePath.split("/");
	if (parts.length !== 3 || parts[0] !== "addressbooks") return;

	let davBookId = book.davAddressBookId || defaultDavBookId;
	if (!davBookId) {
		console.info("[DAV SYNC] Skipping book without davAddressBookId", book.id);
		return;
	}

	const cards = await davDb
		.select()
		.from(davCards)
		.where(eq(davCards.addressbookid, davBookId));

	// Load the local state once instead of one query per card (this runs for
	// every card of every book on each 2-minute sync tick).
	const localByUri = new Map<string, ContactEntity>();
	const localRows = await db
		.select({
			id: contacts.id,
			publicId: contacts.publicId,
			davUri: contacts.davUri,
			davEtag: contacts.davEtag,
		})
		.from(contacts)
		.where(and(eq(contacts.ownerId, book.ownerId), isNotNull(contacts.davUri)));
	for (const row of localRows) {
		if (row.davUri && !localByUri.has(row.davUri)) {
			localByUri.set(row.davUri, row as ContactEntity);
		}
	}

	const remoteUris = new Set<string>();

	for (const card of cards) {
		remoteUris.add(card.uri);

		const localContact = localByUri.get(card.uri);

		if (localContact) {
			if (normalizeEtag(card.etag) !== localContact.davEtag) {
				await updateContact({ card, book, localContact });
			}
		} else {
			console.info(
				"[DAV SYNC] New contact from DAV:",
				card.uri,
				"-> book",
				book.id,
			);
			await createContact({ card, book });
		}
	}

	const localContacts = await db
		.select({ id: contacts.id, davUri: contacts.davUri })
		.from(contacts)
		.where(eq(contacts.addressBookId, book.id));

	const deletedIds = localContacts
		.filter((local) => local.davUri && !remoteUris.has(local.davUri))
		.map((local) => String(local.id));

	if (deletedIds.length) {
		await db.delete(contacts).where(inArray(contacts.id, deletedIds));
	}

	if (deletedIds.length) {
		console.info("[DAV SYNC] Deleted local contacts removed remotely:", {
			bookId: book.id,
			count: deletedIds.length,
			ids: deletedIds,
		});
	}
};

export const davSyncDb = async () => {
	const books = await db
		.select()
		.from(addressBooks)
		.where(eq(addressBooks.isDefault, true));

	const defaultDavBookId: number | null =
		books.length === 1 ? (books[0].davAddressBookId ?? null) : null;

	if (!books.length) {
		console.info("[DAV SYNC] No DAV books found.");
		return;
	}

	for (const book of books) {
		try {
			await syncBook(book as AddressBookEntity, defaultDavBookId);
		} catch (err: any) {
			console.error(
				"[DAV SYNC] Error syncing book",
				book.id,
				err?.message ?? err,
			);
		}
	}

	console.info("[DAV SYNC] Completed.");
};

export function normalizeEtag(etag?: string | null): string | null {
	if (!etag) return null;
	let e = etag.trim();
	if (e.startsWith('"') && e.endsWith('"')) {
		e = e.slice(1, -1);
	}
	const weak = e.match(/^W\/"(.+)"$/);
	if (weak) {
		return weak[1];
	}
	return e.replace(/^W\//, "").replace(/"/g, "");
}
