import { ContactEntity, AddressBookEntity } from "@db";
import { ParsedContactFields } from "./dav-vcard";
import { nanoid } from "nanoid";
import {PutObjectCommand} from "@aws-sdk/client-s3";
import {s3} from "../../../lib/create-s3-client";
import { safeHttpRequest } from "@providers/net-guard";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;


export async function davParsePhoto(
	parsed: ParsedContactFields,
	book: Partial<AddressBookEntity>,
	newContactPublicId: string,
	payload: Partial<ContactEntity>,
) {
	if (!parsed.photo) return;

	const basePath = `private/${book.ownerId}/contacts/${newContactPublicId}`;
	const ext = parsed.photo.ext;

	const mainPath = `${basePath}/${nanoid(12)}.${ext}`;
	const thumbPath = `${basePath}/${nanoid(12)}_xs.${ext}`;

	let mainFile: Buffer | undefined;

	if (parsed.photo?.base64) {
		mainFile = Buffer.from(parsed.photo.base64, "base64");
	} else if (parsed.photo.url) {
		// The URL comes from a synced vCard (user/third-party controlled) and
		// the image is stored readable for the user: guard against SSRF to
		// internal services / cloud metadata, no redirects, size + time cap.
		try {
			const response = await safeHttpRequest(parsed.photo.url, {
				method: "GET",
				timeoutMs: 10_000,
				maxResponseBytes: MAX_PHOTO_BYTES,
			});
			const contentType = String(response.headers["content-type"] ?? "");
			if (
				response.status >= 200 &&
				response.status < 300 &&
				contentType.toLowerCase().startsWith("image/")
			) {
				mainFile = response.body;
			}
		} catch (err) {
			console.warn("[dav] contact photo not fetched", {
				message: (err as Error)?.message,
			});
		}
	}

	if (!mainFile) return;

	const contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;

	await Promise.all([
		s3.send(new PutObjectCommand({
			Bucket: process.env.S3_BUCKET!,
			Key: mainPath,
			Body: mainFile,
			ContentType: contentType,
		})),
		s3.send(new PutObjectCommand({
			Bucket: process.env.S3_BUCKET!,
			Key: thumbPath,
			Body: mainFile,
			ContentType: contentType,
		})),
	]);

	payload.profilePicture = mainPath;
	payload.profilePictureXs = thumbPath;
}
