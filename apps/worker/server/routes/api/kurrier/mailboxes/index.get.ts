import { db, identities, mailboxes } from "@db";
import { and, asc, eq, sql } from "drizzle-orm";
import { defineEventHandler } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";

export default defineEventHandler(async (event) => {
	const { ownerId } = await validateApiKey(event, ["emails:receive"]);

	const rows = await db
		.select({ identity: identities, mailbox: mailboxes })
		.from(identities)
		.leftJoin(mailboxes, eq(identities.id, mailboxes.identityId))
		.where(and(eq(identities.ownerId, ownerId), eq(identities.kind, "email")))
		.orderBy(
			asc(identities.value),
			sql`
				CASE ${mailboxes.kind}
				WHEN 'inbox' THEN 0
				WHEN 'drafts' THEN 1
				WHEN 'sent' THEN 2
				WHEN 'archive' THEN 3
				WHEN 'spam' THEN 4
				WHEN 'trash' THEN 5
				WHEN 'outbox' THEN 6
				ELSE 7
				END
			`,
			asc(mailboxes.name),
		);

	const byIdentity = new Map<
		string,
		{
			identity: typeof identities.$inferSelect;
			mailboxes: (typeof mailboxes.$inferSelect)[];
		}
	>();
	for (const row of rows) {
		const entry = byIdentity.get(row.identity.id) ?? {
			identity: row.identity,
			mailboxes: [],
		};
		if (row.mailbox) entry.mailboxes.push(row.mailbox);
		byIdentity.set(row.identity.id, entry);
	}

	return apiSuccess(Array.from(byIdentity.values()));
});
