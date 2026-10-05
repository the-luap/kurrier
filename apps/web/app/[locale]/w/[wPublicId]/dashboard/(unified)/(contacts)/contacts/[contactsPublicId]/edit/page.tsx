import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type ContactCreate, ContactInsertSchema, contacts } from "@db";
import {
	type FormState,
	getPublicEnv,
	getServerEnv,
	handleAction,
} from "@schema";
import { decode } from "decode-formdata";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import NewContactForm from "@/components/dashboard/contacts/new-contact-form";
import { isSignedIn } from "@/lib/actions/auth";
import { getWorkspacePublicId, rlsClient } from "@/lib/actions/clients";
import { getRedis } from "@/lib/actions/get-redis";
import { s3 } from "@/lib/create-s3-client";
import { getDictionary, type Locale } from "@/lib/dictionaries";

async function Page({
	params,
}: {
	params: Promise<{ contactsPublicId: string; locale: Locale }>;
}) {
	const { contactsPublicId, locale } = await params;

	const rls = await rlsClient();
	const [contact] = await rls((tx) =>
		tx.select().from(contacts).where(eq(contacts.publicId, contactsPublicId)),
	);

	if (!contact) {
		const dict = await getDictionary(locale);
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-4 text-sm text-muted-foreground">
				<p>{dict.contacts.noContactFound}</p>
			</div>
		);
	}

	// Independent lookups in parallel; skip signing when there is no picture.
	const { S3_BUCKET } = getServerEnv();
	const [profilePictureUrl, user, workspacePublicId] = await Promise.all([
		contact.profilePicture
			? getSignedUrl(
					s3,
					new GetObjectCommand({
						Bucket: S3_BUCKET,
						Key: contact.profilePicture,
					}),
					{ expiresIn: 600 },
				)
			: Promise.resolve(null),
		isSignedIn(),
		getWorkspacePublicId(),
	]);
	const publicConfig = getPublicEnv();
	const updateContactAction = async (_prev: FormState, formData: FormData) => {
		"use server";

		return handleAction(async () => {
			const decoded = decode(formData);

			const parsed = ContactInsertSchema.safeParse(decoded);
			if (!parsed.success) {
				return { success: false, error: parsed.error.message };
			}
			const { publicId, ownerId, createdAt, ...updateValues } =
				parsed.data as ContactCreate;

			updateValues.updatedAt = new Date();

			const rls = await rlsClient();
			const [updatedContact] = await rls((tx) =>
				tx
					.update(contacts)
					.set(updateValues)
					.where(eq(contacts.publicId, contactsPublicId))
					.returning(),
			);

			revalidatePath(`/dashboard/contacts/${contactsPublicId}`);
			revalidatePath("/dashboard/contacts");

			const { davQueue } = await getRedis();
			davQueue.add("dav:update-contact", {
				contactId: updatedContact.id,
				ownerId: updatedContact.ownerId,
			});

			return { success: true, data: updatedContact };
		});
	};
	return (
		<NewContactForm
			contact={contact}
			profilePictureUrl={profilePictureUrl}
			createContactAction={updateContactAction}
			user={user}
			workspacePublicId={workspacePublicId}
			publicConfig={publicConfig}
		/>
	);
}

export default Page;
