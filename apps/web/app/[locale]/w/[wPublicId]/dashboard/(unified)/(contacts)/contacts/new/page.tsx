import React from "react";
import NewContactForm from "@/components/dashboard/contacts/new-contact-form";
import { decode } from "decode-formdata";
import { FormState, getPublicEnv, handleAction } from "@schema";
import {getWorkspacePublicId, rlsClient} from "@/lib/actions/clients";
import {
	addressBooks,
	ContactCreate,
	ContactInsertSchema,
	contacts,
} from "@db";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";
import {getRedis} from "@/lib/actions/get-redis";
import { isOwnUploadKey } from "@/lib/upload-keys";

async function Page() {
	const user = await isSignedIn();
	const publicConfig = getPublicEnv();
	const workspacePublicId = await getWorkspacePublicId()
	const createContactAction = async (_prev: FormState, formData: FormData) => {
		"use server";
		return handleAction(async () => {
			const data = decode(formData);
			const rls = await rlsClient();
			const [defaultAddressBook] = await rls((tx) =>
				tx.select().from(addressBooks),
			);

			if (!defaultAddressBook) {
				return {
					success: false,
					error: "contacts.noDefaultAddressBook",
				};
			}
			data.addressBookId = defaultAddressBook.id;

			const res = ContactInsertSchema.safeParse(data);
			if (res.error) {
				return { success: false, error: res.error.message };
			}

			// Only the parsed contact fields; ownership, workspace and DAV
			// columns are never taken from the form.
			const {
				id: _id,
				ownerId: _ownerId,
				workspaceId: _workspaceId,
				davUri: _davUri,
				davEtag: _davEtag,
				createdAt: _createdAt,
				updatedAt: _updatedAt,
				...fields
			} = res.data as ContactCreate;

			// Picture keys are signed for display later: only the caller's
			// own contact uploads.
			const actor = await isSignedIn();
			const contactsPrefix = `private/${actor?.id}/contacts/`;
			for (const value of [fields.profilePicture, fields.profilePictureXs]) {
				if (
					value &&
					!(actor?.id && isOwnUploadKey(value, actor.id) && value.startsWith(contactsPrefix))
				) {
					return { success: false, error: "Invalid profile picture" };
				}
			}

			const payload = {
				...fields,
				addressBookId: defaultAddressBook.id,
			};
			const [newContact] = await rls((tx) =>
				tx
					.insert(contacts)
					.values(payload as ContactCreate)
					.returning(),
			);

			const { davQueue } = await getRedis();
			davQueue.add("dav:create-contact", {
				contactId: newContact.id,
				ownerId: newContact.ownerId,
			});

			revalidatePath("/dashboard/contacts/new");
			return { success: true, data: newContact };
		});
	};

	return (
		<NewContactForm
			createContactAction={createContactAction}
			user={user}
			workspacePublicId={workspacePublicId}
			publicConfig={publicConfig}
		/>
	);
}

export default Page;
