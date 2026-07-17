import { getEnv } from "@schema";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieStore = Awaited<ReturnType<typeof cookies>>;
type CookieToSet = {
	name: string;
	value: string;
	options?: Parameters<CookieStore["set"]>[2];
};

export async function createClient() {
	const cookieStore = await cookies();
	const {
		public: { ANON_KEY, WEB_URL },
	} = getEnv();

	return createServerClient(`${WEB_URL}/api/kong`, ANON_KEY, {
		cookies: {
			getAll() {
				return cookieStore.getAll();
			},
			setAll(cookiesToSet: CookieToSet[]) {
				try {
					cookiesToSet.forEach(({ name, value, options }) => {
						cookieStore.set(name, value, options);
					});
				} catch {
					// The `setAll` method was called from a Server Component.
					// This can be ignored if you have middleware refreshing
					// user sessions.
				}
			},
		},
	});
}
