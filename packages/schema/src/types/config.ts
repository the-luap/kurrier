import { z } from "zod";

/** Common helpers */
const ZPort = z.coerce.number().int().min(1).max(65535);
const ZNodeEnv = z.enum(["development", "production", "test"]);

/** Server-only (never sent to the browser) */
export const ZServerConfig = z.object({
	WEB_PORT: ZPort.default(3000),
	NODE_ENV: ZNodeEnv.default("development"),
	DATABASE_URL: z.string(
		"DATABASE_URL must be a valid Postgres connection URL",
	),
	DATABASE_RLS_URL: z.string(
		"DATABASE_RLS_URL must be a valid Postgres connection URL",
	),
	JWT_SECRET: z.string("JWT_SECRET must be present"),
	APP_SECRET_ENCRYPTION_KEY: z.string("APP_SECRET_ENCRYPTION_KEY must be present"),
	REDIS_PASSWORD: z.string("REDIS_PASSWORD must be present"),
	REDIS_HOST: z.string("REDIS_HOST must be present"),
	REDIS_PORT: z.string("REDIS_PORT must be present"),
	TYPESENSE_API_KEY: z.string("TYPESENSE_API_KEY must be present"),
	TYPESENSE_PORT: z.string("TYPESENSE_PORT must be present"),
	TYPESENSE_PROTOCOL: z.string("TYPESENSE_PROTOCOL must be present"),
	TYPESENSE_HOST: z.string("TYPESENSE_HOST must be present"),
	SEARCH_REBUILD_ON_BOOT: z.string("SEARCH_REBUILD_ON_BOOT must be present"),
	S3_REGION: z.string("S3_REGION must be present"),
	S3_BUCKET: z.string("S3_BUCKET must be present"),
	S3_ENDPOINT: z.string("S3_ENDPOINT must be present"),
	S3_ACCESS_KEY: z.string("S3_ACCESS_KEY must be present"),
	S3_SECRET_KEY: z.string("S3_SECRET_KEY must be present"),
	S3_FORCE_PATH_STYLE: z.string("S3_FORCE_PATH_STYLE must be present"),
	// Shared secret for the Mailgun/Postmark/SendGrid inbound webhooks. Required
	// in production (the worker rejects inbound webhooks while it is unset).
	INBOUND_WEBHOOK_SECRET: z.string().optional(),
	// Optional defaults for the AI reply drafts (Ollama). Users configure their
	// own endpoint in Platform > AI; these only prefill the form.
	OLLAMA_BASE_URL: z.string().optional(),
	OLLAMA_MODEL: z.string().optional(),
});

/** Safe to expose to the browser */
export const ZPublicConfig = z.object({
	WEB_URL: z.string("WEB_URL must be present"),
	DOCS_URL: z.string().optional(),
	DAV_URL: z.string("DAV_URL must be present"),
	DISABLE_SIGNUP: z.string().optional().transform((val) => val === "true").default(false),
});

export type ServerConfig = z.infer<typeof ZServerConfig>;
export type PublicConfig = z.infer<typeof ZPublicConfig>;

// Use a generic env shape so this package doesn't depend on Node typings
type RawEnv = Record<string, string | undefined>;

function formatZodError(label: string, err: z.ZodError) {
	const flat = err.flatten();

	const fieldErrors = Object.entries(flat.fieldErrors)
		.map(([k, v]) => {
			// v is `unknown` to TS; make it a string[] safely
			const msgs = Array.isArray(v) ? (v as string[]) : [];
			return `  - ${k}: ${msgs.join(", ")}`;
		})
		.join("\n");

	const formErrors = (flat.formErrors ?? []).map((e) => `  - ${e}`).join("\n");

	return `[${label}] Invalid configuration\n${fieldErrors}${formErrors ? `\n${formErrors}` : ""}`;
}

export function parseServerConfig(env: RawEnv): ServerConfig {
	const res = ZServerConfig.safeParse(env);
	if (!res.success) throw new Error(formatZodError("ServerConfig", res.error));
	return res.data;
}

export function parsePublicConfig(env: RawEnv): PublicConfig {
	const res = ZPublicConfig.safeParse(env);
	if (!res.success) throw new Error(formatZodError("PublicConfig", res.error));
	return res.data;
}

/** Convenience: parse both in one call (optionally cached) */
let _cache: { server: ServerConfig; public: PublicConfig } | null = null;

export function parseEnv(env: RawEnv): {
	server: ServerConfig;
	public: PublicConfig;
} {
	return {
		server: parseServerConfig(env),
		public: parsePublicConfig(env),
	};
}

// process.env does not change at runtime, so its parse result is reused.
// These getters run many times per request (every queue, client and
// action), and each call used to re-run the full zod validation.
let _serverCache: ServerConfig | null = null;
let _publicCache: PublicConfig | null = null;

/** Return only server-side envs */
export function getServerEnv(env?: RawEnv): ServerConfig {
	if (env && env !== (process.env as unknown as RawEnv)) {
		return parseServerConfig(env);
	}
	if (!_serverCache) {
		_serverCache = parseServerConfig(process.env as unknown as RawEnv);
	}
	return _serverCache;
}

export function getPublicEnv(env?: RawEnv): PublicConfig {
	if (env && env !== (process.env as unknown as RawEnv)) {
		return parsePublicConfig(env);
	}
	if (!_publicCache) {
		_publicCache = parsePublicConfig(process.env as unknown as RawEnv);
	}
	return _publicCache;
}

export function getEnv(env: RawEnv = process.env as unknown as RawEnv) {
	return (_cache ??= parseEnv(env));
}
