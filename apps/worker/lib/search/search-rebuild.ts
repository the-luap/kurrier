import { messages } from "@db";
import { messagesSearchSchema } from "@schema";
import { asc, gt } from "drizzle-orm";
import client from "../../lib/get-typesense";
import { rowToDoc, selectJoinedRows } from "./search-operations";

const BATCH_SIZE = 2000;

export const rebuild = async () => {
	console.log("[typesense] rebuilding collection…");

	try {
		await client.collections("messages").delete();
	} catch {}
	await client.collections().create(messagesSearchSchema);
	console.log("[typesense] created collection messages");

	let imported = 0;
	let lastId: string | null = null;

	while (true) {
		// Keyset pagination on the primary key: LIMIT/OFFSET without ORDER BY
		// could skip or repeat rows and got slower with every page.
		const query = selectJoinedRows();
		const batch = await (lastId ? query.where(gt(messages.id, lastId)) : query)
			.orderBy(asc(messages.id))
			.limit(BATCH_SIZE);

		if (batch.length === 0) break;
		lastId = batch[batch.length - 1].m.id;

		const docs = batch.map(rowToDoc);

		// throwOnFail: false, so a few bad documents are reported below
		// instead of aborting the whole rebuild.
		const result = await client
			.collections("messages")
			.documents()
			.import(docs, { action: "upsert", throwOnFail: false });

		const failed = result.filter((r) => r.success !== true);
		if (failed.length)
			console.warn("[typesense] some docs failed", failed.slice(0, 5));

		imported += docs.length;
		console.log(`[typesense] upserted ${imported}`);

		if (batch.length < BATCH_SIZE) break;
	}

	console.log("[typesense] indexing done");
};
