import { defineNitroPlugin } from "nitropack/runtime";
import {runMigrationsForWorkspace} from "../../lib/migrations/run-migration";
import { workerOptions } from "../../lib/get-redis";
import { Worker } from "bullmq";

function startMigrationWorker() {
	const worker = new Worker(
		"migration-worker",
		async (job) => {
			switch (job.name) {
				case "migration:run-for-user-after-signup":
					return runMigrationsForWorkspace(job.data.userId, job.data.workspaceId, job.data.email);
				default:
					return { success: true, skipped: true };
			}
		},
		workerOptions(),
	);
	worker.on("completed", (job) => {
		console.info(`Migration job ${job.id} (${job.name}) completed`);
	});

	worker.on("failed", (job, err) => {
		console.error(
			`Migration job ${job?.id} (${job?.name}) failed: ${err.message}`,
		);
	});
	return worker;
}

export default defineNitroPlugin(async (nitroApp) => {
	const worker = startMigrationWorker();
	nitroApp.hooks.hookOnce("close", async () => {
		await worker.close().catch((err: any) => {
			console.error("Error closing migration worker:", err?.message ?? err);
		});
	});
});
