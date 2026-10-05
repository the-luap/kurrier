import { identities } from "@db";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { rlsClient } from "@/lib/actions/clients";

/**
 * Request-deduplicated identity lookup. The mailbox header, the settings
 * layout and the settings pages all need the same row; with `cache` they
 * share one query per request instead of running it up to three times.
 * Server-only (uses the RLS database client).
 */
export const getIdentityByPublicId = cache(async (identityPublicId: string) => {
	const rls = await rlsClient();
	const [identity] = await rls((tx) =>
		tx
			.select()
			.from(identities)
			.where(eq(identities.publicId, identityPublicId)),
	);
	return identity ?? null;
});
