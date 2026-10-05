import {JobScheduler, Worker} from "bullmq";
import { defineNitroPlugin } from "nitropack/runtime";
import { redisConnection, workerOptions } from "../../lib/get-redis";
import { createCalendarEvent } from "../../lib/dav/calendar/dav-create-calendar-event";
import { deleteCalendarEvent } from "../../lib/dav/calendar/dav-delete-calendar-event";
import { updateCalendarEvent } from "../../lib/dav/calendar/dav-update-calendar-event";
import { davItipProcessor } from "../../lib/dav/calendar/dav-itip-processor";
import { davItipNotify } from "../../lib/dav/calendar/dav-itip-notify";
import { davItipReply } from "../../lib/dav/calendar/dav-itip-reply";
import { davCreateCalendarForIdentity } from "../../lib/dav/calendar/dav-create-addressbook-calendar-for-identity";
import {davIdentityCleanup} from "../../lib/dav/dav-share-identity";
import {createContact} from "../../lib/dav/dav-create-contact";
import {updatePassword} from "../../lib/dav/dav-update-password";
import {davSyncDb} from "../../lib/dav/sync/dav-sync-db";
import {pushUpdateContact} from "../../lib/dav/dav-update-contact";
import {deleteContact} from "../../lib/dav/dav-delete-contact";
import {davSyncCalendarsDb} from "../../lib/dav/calendar/dav-sync-calendar-db";
import { contacts, db } from "@db";
import { and, inArray, isNotNull } from "drizzle-orm";

export default defineNitroPlugin(async (nitroApp) => {
	const connection = redisConnection.connection

	const worker = new Worker(
		"dav-worker",
		async (job) => {
			console.log(
				"[WORKER INSTANCE]",
				process.pid,
				"received job",
				job.name,
				job.id,
			);
			switch (job.name) {
				case "dav:create-identity":
					return davCreateCalendarForIdentity(job.data);
				case "dav:calendar:create-event":
					return createCalendarEvent(
						job.data.eventId,
						job.data.notifyAttendees,
						job.data.uid,
					);
				case "dav:calendar:update-event":
					return updateCalendarEvent(
						job.data.eventId,
						job.data.notifyAttendees,
					);
				case "dav:calendar:delete-event":
					return deleteCalendarEvent(
						job.data.eventId,
						job.data.notifyAttendees,
						job.data.deleteEvent,
					);
				case "dav:calendar:itip-notify":
					return davItipNotify({
						eventId: job.data.eventId,
						action: job.data.action,
					});
				case "dav:calendar:itip-reply":
					return davItipReply({
						eventId: job.data.eventId,
						attendeeId: job.data.attendeeId,
						partstat: job.data.partstat,
					});
				case "dav:calendar:itip-ingest-batch":
					return davItipProcessor(job.data.items);
				case "dav:delete:identity":
					return davIdentityCleanup(job.data);
				case "dav:update-password":
					return updatePassword(job.data.userId, job.data.workspaceId);


				case "dav:sync":
					console.log("[DAV WORKER] Starting DAV sync job:", job.id);
					await davSyncDb();
					await davSyncCalendarsDb();
					return;
				case "dav:update-contact":
					return pushUpdateContact(job.data.contactId, job.data.ownerId);
				case "dav:create-contact":
					return createContact(job.data.contactId, job.data.ownerId);
				case "dav:delete-contact":
					return deleteContact({
						contactId: job.data.contactId,
						ownerId: job.data.ownerId,
					});

				case "dav:create-contacts-batch": {
					const { ownerId } = job.data;
					// Older producers sent null / "null" for messages without a
					// contact, and the same sender once per message.
					const contactIds: string[] = [
						...new Set<string>(
							(job.data.contactIds ?? []).filter(
								(id: unknown) =>
									typeof id === "string" && id !== "" && id !== "null",
							),
						),
					];

					console.log(
						`[DAV WORKER] Processing contacts batch (${contactIds.length})`,
					);
					// Every stored message enqueues its sender: skip contacts that
					// already have a DAV card (the If-None-Match PUT would only fail
					// after a secret lookup and an HTTP round trip).
					const alreadySynced = new Set(
						contactIds.length
							? (
									await db
										.select({ id: contacts.id })
										.from(contacts)
										.where(
											and(
												inArray(contacts.id, contactIds),
												isNotNull(contacts.davUri),
											),
										)
								).map((r) => r.id)
							: [],
					);
					const results = [];
					for (const id of contactIds) {
						if (alreadySynced.has(id)) {
							results.push({ id, success: true, skipped: true });
							continue;
						}
						try {
							const r = await createContact(id, ownerId);
							results.push({ id, success: true, result: r });
						} catch (err: any) {
							results.push({
								id,
								success: false,
								error: err?.message ?? err,
							});
						}
					}

					return {
						ok: true,
						total: contactIds.length,
						results,
					};
				}
				default:
					return { success: true, skipped: true };
			}
		},
		workerOptions({ concurrency: 1 }),
	);


	const scheduler = new JobScheduler("dav-worker", { connection });
	await scheduler.upsertJobScheduler(
		"dav-sync-scheduler",
		{ every: 15000 },
		"dav:sync",
		{},
		{
			removeOnComplete: true,
			removeOnFail: true,
		},
		{ override: true },
	);

	worker.on("completed", (job) => {
		console.info(`DAV job ${job.id} (${job.name}) completed`);
	});

	worker.on("failed", (job, err) => {
		console.error(`DAV job ${job?.id} (${job?.name}) failed: ${err.message}`);
	});


	nitroApp.hooks.hookOnce("close", async () => {
		console.info("Closing nitro server...");
		console.info("Shutting down dav worker!");
		try {
			await Promise.allSettled([
				worker?.close(),
			]);
		} catch (err: any) {
			console.error("Error closing BullMQ resources:", err?.message ?? err);
		}
	});
});
