import { PgDatabase } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jwtDecode, JwtPayload } from "jwt-decode";
import { db, db_rls } from "./init-db";
import { AuthSession } from "@supabase/supabase-js";

export function decode(accessToken: string) {
	try {
		return jwtDecode<JwtPayload & { role: string }>(accessToken);
	} catch (error) {
		return { role: "anon" } as JwtPayload & { role: string };
	}
}

type SupabaseToken = {
	iss?: string;
	sub?: string;
	aud?: string[] | string;
	exp?: number;
	nbf?: number;
	iat?: number;
	jti?: string;
	role?: string;
};

export function createDrizzle<Database extends PgDatabase<any, any, any>>(
	token: SupabaseToken,
	{ admin, client }: { admin: Database; client: Database },
) {
	return {
		admin,
		rls: (async (transaction, ...rest) => {
			return client.transaction(
				async (tx) => {
					// 1) set JWT claims + local role in a single round trip.
					//    set_config('role', ..., true) is equivalent to SET LOCAL ROLE
					//    and lets the role be passed as a parameter.
					await tx.execute(
						sql`select set_config('request.jwt.claims', ${JSON.stringify(token)}, true), set_config('request.jwt.claim.sub', ${token.sub ?? ""}, true), set_config('role', ${token.role ?? "anon"}, true)`,
					);

					// 2) run caller work
					return transaction(tx);
					// 3) no finally/cleanup needed: LOCAL settings auto-reset at commit/rollback
				},
				...rest,
			);
		}) as typeof client.transaction,
	};
}

export async function createDrizzleSupabaseClient(session: AuthSession) {
	return createDrizzle(decode(session?.access_token ?? ""), {
		admin: db,
		client: db_rls,
	});
}
