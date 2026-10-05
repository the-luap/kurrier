import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { addressBooks, contactLabels, contacts, labels } from "@db";
import { getServerEnv } from "@schema";
import { eq } from "drizzle-orm";
import type React from "react";
import type { ContactWithFavorite } from "@/components/dashboard/contacts/contacts-list";
import ContactsShell from "@/components/dashboard/contacts/contacts-shell";
import DashboardPageHeader from "@/components/dashboard/dashboard-page-header";
import { getWorkspacePublicId, rlsClient } from "@/lib/actions/clients";
import { s3 } from "@/lib/create-s3-client";
import { getDictionary } from "@/lib/dictionaries";

export default async function ContactsLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	const rls = await rlsClient();

	// Only the columns the list renders: this array is serialized into the
	// client component, so full rows (vCard, notes, addresses, phones, DAV
	// metadata, ...) for every contact would bloat the RSC payload.
	const [dict, rows, workspacePublicId, [userBook]] = await Promise.all([
		getDictionary(locale),
		rls((tx) =>
			tx
				.select({
					contact: {
						id: contacts.id,
						publicId: contacts.publicId,
						firstName: contacts.firstName,
						lastName: contacts.lastName,
						company: contacts.company,
						emails: contacts.emails,
						profilePictureXs: contacts.profilePictureXs,
						addressBookId: contacts.addressBookId,
					},
					labelSlug: labels.slug,
				})
				.from(contacts)
				.leftJoin(contactLabels, eq(contactLabels.contactId, contacts.id))
				.leftJoin(labels, eq(labels.id, contactLabels.labelId)),
		),
		getWorkspacePublicId(),
		rls((tx) => tx.select().from(addressBooks).limit(1)),
	]);

	const grouped = new Map<string, ContactWithFavorite & { labels: string[] }>();

	for (const row of rows) {
		const existing = grouped.get(row.contact.id) ?? {
			...row.contact,
			isFavorite: false,
			labels: [],
		};

		if (row.labelSlug && !existing.labels.includes(row.labelSlug)) {
			existing.labels.push(row.labelSlug);
		}

		if (row.labelSlug === "favorite") {
			existing.isFavorite = true;
		}

		grouped.set(row.contact.id, existing);
	}

	const allContacts = Array.from(grouped.values());

	const { S3_BUCKET } = getServerEnv();
	const uniqueKeys = Array.from(
		new Set(
			allContacts.map((c) => c.profilePictureXs).filter(Boolean) as string[],
		),
	);

	const profileImages = await Promise.all(
		uniqueKeys.map(async (key) => {
			const signedUrl = await getSignedUrl(
				s3,
				new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
				{ expiresIn: 600 },
			);
			return { path: key, signedUrl };
		}),
	);

	return (
		<>
			<DashboardPageHeader title={dict.contacts.contacts} />

			<ContactsShell
				userContacts={allContacts}
				profileImages={profileImages}
				workspacePublicId={workspacePublicId}
				userBook={userBook}
			>
				{children}
			</ContactsShell>
		</>
	);
}
