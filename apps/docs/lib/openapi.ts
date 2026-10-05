// OpenAPI 3.1 description of the Kurrier HTTP API (apps/worker/server/routes/api/kurrier).
// Served by the docs app at /openapi.json and /api/openapi.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });

const ok = (description: string, data: unknown) => ({
	description,
	content: {
		"application/json": {
			schema: {
				type: "object",
				required: ["success", "data"],
				properties: { success: { const: true }, data },
			},
		},
	},
});

const errors = {
	"400": resp("BadRequest"),
	"401": resp("Unauthorized"),
	"403": resp("Forbidden"),
	"404": resp("NotFound"),
};

const jsonBody = (schema: unknown, required = true) => ({
	required,
	content: { "application/json": { schema } },
});

const idParam = (description: string) => ({
	name: "id",
	in: "path",
	required: true,
	description,
	schema: { type: "string" },
});

const query = (
	name: string,
	description: string,
	schema: Record<string, unknown> = { type: "string" },
) => ({ name, in: "query", required: false, description, schema });

const userEmailParam = query(
	"userEmail",
	"Admin API key only: act as this user (their own workspace).",
	{ type: "string", format: "email" },
);

const paginationParams = [
	query("limit", "Page size (1-100).", {
		type: "integer",
		minimum: 1,
		maximum: 100,
		default: 50,
	}),
	query("offset", "Rows to skip (0-10000).", {
		type: "integer",
		minimum: 0,
		maximum: 10000,
		default: 0,
	}),
];

const bodyParams = [
	query("includeHtml", "Include the HTML body.", { type: "boolean" }),
	query("includeText", "Include the plain-text body.", { type: "boolean" }),
	query("includeHeaders", "Include the parsed headers.", { type: "boolean" }),
];

const scope = (s: string) => `Scope: \`${s}\`.`;
const READ = scope("emails:receive");
const SEND = scope("emails:send");
const MANAGE = "Scope: `emails:send` or `emails:receive`.";

export const kurrierOpenApiSpec = {
	openapi: "3.1.0",
	info: {
		title: "Kurrier API",
		version: "1.0.0",
		description:
			"HTTP+JSON API for reading mailboxes and messages, sending and replying to email, ingesting inbound mail and managing identities, SMTP accounts and webhooks.\n\n" +
			"Every route acts inside the workspace of the API key. Scopes are enforced only when the key has a non-empty scopes list.",
	},
	servers: [
		{
			url: "{origin}/api/kurrier",
			description: "Your Kurrier instance (the worker / API host)",
			variables: { origin: { default: "https://your-domain.com" } },
		},
	],
	security: [{ bearerAuth: [] }],
	tags: [
		{ name: "Discovery" },
		{ name: "Me" },
		{ name: "Mailboxes" },
		{ name: "Messages" },
		{ name: "Email" },
		{ name: "Inbound" },
		{ name: "Identities" },
		{ name: "SMTP accounts" },
		{ name: "Webhooks" },
		{ name: "Users" },
	],
	paths: {
		"/": {
			get: {
				tags: ["Discovery"],
				summary: "List the available API routes",
				security: [],
				responses: { "200": { description: "Discovery document" } },
			},
		},
		"/me": {
			get: {
				tags: ["Me"],
				summary: "The user the API key belongs to",
				description: MANAGE,
				responses: {
					"200": ok("User", {
						type: "object",
						properties: {
							id: { type: "string", format: "uuid" },
							email: { type: "string" },
						},
					}),
					...errors,
				},
			},
		},
		"/mailboxes": {
			get: {
				tags: ["Mailboxes"],
				summary: "Identities with their mailboxes",
				description: `Email identities of the key's workspace that the key's user owns, is a member of, or that are shared with the workspace. ${READ}`,
				parameters: [
					query("identityId", "Only this identity (uuid or publicId)."),
					userEmailParam,
				],
				responses: {
					"200": ok("Mailboxes per identity", {
						type: "array",
						items: ref("IdentityMailboxes"),
					}),
					...errors,
				},
			},
		},
		"/mailboxes/overview": {
			get: {
				tags: ["Mailboxes"],
				summary: "Mailboxes with unread counts",
				description: `Adds unreadCount, unreadThreads, totalThreads and up to three recent unread threads per inbox. ${READ}`,
				parameters: [userEmailParam],
				responses: {
					"200": ok("Overview per identity", {
						type: "array",
						items: ref("IdentityMailboxes"),
					}),
					...errors,
				},
			},
		},
		"/identities/{id}/mailboxes": {
			get: {
				tags: ["Mailboxes"],
				summary: "Mailboxes of one identity",
				description: READ,
				parameters: [idParam("Identity uuid or publicId"), userEmailParam],
				responses: {
					"200": ok("Mailboxes", ref("IdentityMailboxes")),
					...errors,
				},
			},
		},
		"/mailboxes/{id}/threads": {
			get: {
				tags: ["Mailboxes"],
				summary: "Threads of a mailbox",
				description: `Newest activity first. ${READ}`,
				parameters: [
					idParam("Mailbox uuid or publicId"),
					...paginationParams,
					query("unread", "Only threads with unread messages.", {
						type: "boolean",
					}),
					userEmailParam,
				],
				responses: {
					"200": ok("Threads", {
						type: "object",
						properties: {
							mailbox: ref("Mailbox"),
							threads: { type: "array", items: ref("ThreadSummary") },
							pagination: ref("Pagination"),
						},
					}),
					...errors,
				},
			},
		},
		"/mailboxes/{id}/messages": {
			get: {
				tags: ["Mailboxes", "Messages"],
				summary: "Messages of a mailbox",
				description: `Newest first. Bodies only with includeHtml/includeText. ${READ}`,
				parameters: [
					idParam("Mailbox uuid or publicId"),
					...paginationParams,
					...bodyParams,
					userEmailParam,
				],
				responses: {
					"200": ok("Messages", {
						type: "object",
						properties: {
							mailbox: ref("Mailbox"),
							messages: { type: "array", items: ref("Message") },
							pagination: ref("Pagination"),
						},
					}),
					...errors,
				},
			},
		},
		"/messages": {
			get: {
				tags: ["Messages"],
				summary: "Messages across all readable mailboxes",
				description: `Newest first. Alias: \`GET /emails\`. ${READ}`,
				parameters: [
					query("mailboxId", "Only this mailbox (uuid or publicId)."),
					query("threadId", "Only this thread (uuid).", {
						type: "string",
						format: "uuid",
					}),
					query("unread", "Only unseen messages.", { type: "boolean" }),
					...paginationParams,
					...bodyParams,
					userEmailParam,
				],
				responses: {
					"200": ok("Messages", {
						type: "object",
						properties: {
							messages: { type: "array", items: ref("Message") },
							pagination: ref("Pagination"),
						},
					}),
					...errors,
				},
			},
		},
		"/emails": {
			get: {
				tags: ["Messages"],
				summary: "Alias of GET /messages",
				description: READ,
				responses: {
					"200": { description: "Same as GET /messages" },
					...errors,
				},
			},
		},
		"/messages/{id}": {
			get: {
				tags: ["Messages"],
				summary: "One message",
				description: `html and text are included by default (pass includeHtml=false / includeText=false to skip). Alias: \`GET /emails/{id}\`. ${READ}`,
				parameters: [
					idParam("Message uuid or publicId"),
					...bodyParams,
					userEmailParam,
				],
				responses: { "200": ok("Message", ref("Message")), ...errors },
			},
		},
		"/emails/{id}": {
			get: {
				tags: ["Messages"],
				summary: "Alias of GET /messages/{id}",
				description: READ,
				parameters: [idParam("Message uuid or publicId")],
				responses: { "200": ok("Message", ref("Message")), ...errors },
			},
		},
		"/threads/{id}/messages": {
			get: {
				tags: ["Messages"],
				summary: "Messages of a thread",
				description: `Oldest first, limited to mailboxes the key can read. ${READ}`,
				parameters: [
					idParam("Thread uuid"),
					...paginationParams,
					...bodyParams,
					userEmailParam,
				],
				responses: {
					"200": ok("Thread messages", {
						type: "object",
						properties: {
							thread: {
								type: "object",
								properties: {
									id: { type: "string", format: "uuid" },
									messageCount: { type: "integer" },
									lastMessageDate: {
										type: ["string", "null"],
										format: "date-time",
									},
									createdAt: { type: "string", format: "date-time" },
								},
							},
							messages: { type: "array", items: ref("Message") },
							pagination: ref("Pagination"),
						},
					}),
					...errors,
				},
			},
		},
		"/email/send": {
			post: {
				tags: ["Email"],
				summary: "Send a new email",
				description: `Queued on the send-mail worker. Alias: \`POST /email/compose\`. ${SEND}`,
				requestBody: jsonBody(ref("EmailSendRequest")),
				responses: { "200": ok("Queued", ref("EmailQueued")), ...errors },
			},
		},
		"/email/compose": {
			post: {
				tags: ["Email"],
				summary: "Alias of POST /email/send",
				description: SEND,
				requestBody: jsonBody(ref("EmailSendRequest")),
				responses: { "200": ok("Queued", ref("EmailQueued")), ...errors },
			},
		},
		"/email/reply": {
			post: {
				tags: ["Email"],
				summary: "Reply to a message or thread",
				description: `The original must be readable by the key. The reply is threaded (In-Reply-To/References), gets a "Re:" subject unless one is given and quotes the original. ${SEND}`,
				requestBody: jsonBody(ref("EmailReplyRequest")),
				responses: { "200": ok("Queued", ref("EmailQueued")), ...errors },
			},
		},
		"/inbound": {
			post: {
				tags: ["Inbound"],
				summary: "Ingest a raw RFC822 message",
				description: `Stores the message in the inbox of an inbound identity of the key's workspace. ${MANAGE}`,
				parameters: [
					{
						name: "X-Kurrier-Identity",
						in: "header",
						required: true,
						description: "Inbound identity id",
						schema: { type: "string", format: "uuid" },
					},
				],
				requestBody: {
					required: true,
					content: { "message/rfc822": { schema: { type: "string" } } },
				},
				responses: { "200": { description: "Stored message" }, ...errors },
			},
		},
		"/identities": {
			get: {
				tags: ["Identities"],
				summary: "List identities owned by the key's user",
				description: MANAGE,
				responses: { "200": { description: "Identities" }, ...errors },
			},
			post: {
				tags: ["Identities"],
				summary: "Create an email identity on an SMTP account",
				description: `Admin key: pass userEmail. ${MANAGE}`,
				requestBody: jsonBody({ type: "object" }),
				responses: { "200": { description: "Created identity" }, ...errors },
			},
		},
		"/identities/{id}": {
			parameters: [idParam("Identity uuid")],
			get: {
				tags: ["Identities"],
				summary: "Get an identity",
				description: MANAGE,
				responses: { "200": { description: "Identity" }, ...errors },
			},
			patch: {
				tags: ["Identities"],
				summary: "Update an identity",
				description: MANAGE,
				requestBody: jsonBody({ type: "object" }),
				responses: { "200": { description: "Updated identity" }, ...errors },
			},
			delete: {
				tags: ["Identities"],
				summary: "Delete an identity",
				description: MANAGE,
				responses: { "200": { description: "Deleted" }, ...errors },
			},
		},
		"/smtp-accounts": {
			get: {
				tags: ["SMTP accounts"],
				summary: "List SMTP accounts",
				description: MANAGE,
				parameters: [userEmailParam],
				responses: { "200": { description: "SMTP accounts" }, ...errors },
			},
			post: {
				tags: ["SMTP accounts"],
				summary: "Create an SMTP account",
				description: MANAGE,
				requestBody: jsonBody({ type: "object" }),
				responses: { "200": { description: "Created account" }, ...errors },
			},
		},
		"/smtp-accounts/{id}": {
			parameters: [idParam("SMTP account uuid")],
			get: {
				tags: ["SMTP accounts"],
				summary: "Get an SMTP account",
				description: MANAGE,
				responses: { "200": { description: "Account" }, ...errors },
			},
			patch: {
				tags: ["SMTP accounts"],
				summary: "Update an SMTP account",
				description: MANAGE,
				requestBody: jsonBody({ type: "object" }),
				responses: { "200": { description: "Updated account" }, ...errors },
			},
			delete: {
				tags: ["SMTP accounts"],
				summary: "Delete an SMTP account",
				description: MANAGE,
				responses: { "200": { description: "Deleted" }, ...errors },
			},
		},
		"/webhooks": {
			get: {
				tags: ["Webhooks"],
				summary: "List webhooks",
				description: MANAGE,
				responses: { "200": { description: "Webhooks" }, ...errors },
			},
			post: {
				tags: ["Webhooks"],
				summary: "Create a webhook",
				description: MANAGE,
				requestBody: jsonBody({
					type: "object",
					required: ["url", "events"],
					properties: {
						url: { type: "string", format: "uri" },
						events: {
							type: "array",
							items: { type: "string", enum: ["message.received"] },
						},
						identityId: { type: "string", format: "uuid" },
						description: { type: "string" },
						enabled: { type: "boolean" },
					},
				}),
				responses: { "200": { description: "Created webhook" }, ...errors },
			},
		},
		"/webhooks/{id}": {
			parameters: [idParam("Webhook uuid")],
			get: {
				tags: ["Webhooks"],
				summary: "Get a webhook",
				description: MANAGE,
				responses: { "200": { description: "Webhook" }, ...errors },
			},
			patch: {
				tags: ["Webhooks"],
				summary: "Update a webhook",
				description: MANAGE,
				requestBody: jsonBody({ type: "object" }),
				responses: { "200": { description: "Updated webhook" }, ...errors },
			},
			delete: {
				tags: ["Webhooks"],
				summary: "Delete a webhook",
				description: MANAGE,
				responses: { "200": { description: "Deleted" }, ...errors },
			},
		},
		"/users": {
			post: {
				tags: ["Users"],
				summary: "Provision a user",
				description: "Admin API key (`API_ADMIN_KEY`) only.",
				requestBody: jsonBody({ type: "object" }),
				responses: { "200": { description: "User" }, ...errors },
			},
		},
	},
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				description:
					"API key from Dashboard → Platform → API keys, or the instance admin key (API_ADMIN_KEY).",
			},
		},
		responses: {
			BadRequest: {
				description: "Invalid request",
				content: { "application/json": { schema: ref("Error") } },
			},
			Unauthorized: {
				description: "Missing, invalid, revoked or expired API key",
				content: { "application/json": { schema: ref("Error") } },
			},
			Forbidden: {
				description: "Missing scope or no access to the resource",
				content: { "application/json": { schema: ref("Error") } },
			},
			NotFound: {
				description: "Not found in the key's workspace",
				content: { "application/json": { schema: ref("Error") } },
			},
		},
		schemas: {
			Error: {
				type: "object",
				properties: {
					statusCode: { type: "integer" },
					statusMessage: { type: "string" },
					message: { type: "string" },
					data: {},
				},
			},
			Pagination: {
				type: "object",
				properties: {
					limit: { type: "integer" },
					offset: { type: "integer" },
					nextOffset: { type: ["integer", "null"] },
				},
			},
			Identity: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					publicId: { type: "string" },
					kind: { type: "string", enum: ["email", "domain"] },
					value: { type: "string" },
					displayName: { type: ["string", "null"] },
					status: { type: "string" },
					sharedWithWorkspace: { type: "boolean" },
				},
			},
			Mailbox: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					publicId: { type: "string" },
					identityId: { type: "string", format: "uuid" },
					parentId: { type: ["string", "null"], format: "uuid" },
					kind: {
						type: "string",
						enum: [
							"inbox",
							"sent",
							"drafts",
							"archive",
							"spam",
							"trash",
							"outbox",
							"custom",
						],
					},
					name: { type: ["string", "null"] },
					slug: { type: ["string", "null"] },
					isDefault: { type: "boolean" },
					unreadCount: { type: "integer", description: "overview only" },
					unreadThreads: { type: "integer", description: "overview only" },
					totalThreads: { type: "integer", description: "overview only" },
					recentThreads: {
						type: "array",
						items: ref("ThreadSummary"),
						description: "overview only",
					},
				},
			},
			IdentityMailboxes: {
				type: "object",
				properties: {
					identity: ref("Identity"),
					mailboxes: { type: "array", items: ref("Mailbox") },
				},
			},
			ThreadSummary: {
				type: "object",
				properties: {
					threadId: { type: "string", format: "uuid" },
					mailboxId: { type: "string", format: "uuid" },
					subject: { type: ["string", "null"] },
					previewText: { type: ["string", "null"] },
					participants: { type: ["object", "null"] },
					lastActivityAt: { type: "string", format: "date-time" },
					messageCount: { type: "integer" },
					unreadCount: { type: "integer" },
					hasAttachments: { type: "boolean" },
					starred: { type: "boolean" },
					snoozedUntil: { type: ["string", "null"], format: "date-time" },
				},
			},
			AddressObject: {
				type: ["object", "null"],
				properties: {
					value: {
						type: "array",
						items: {
							type: "object",
							properties: {
								address: { type: ["string", "null"] },
								name: { type: "string" },
							},
						},
					},
					text: { type: "string" },
				},
			},
			Attachment: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					messageId: { type: "string", format: "uuid" },
					filename: { type: ["string", "null"] },
					contentType: { type: ["string", "null"] },
					sizeBytes: { type: ["integer", "null"] },
					cid: { type: ["string", "null"] },
					isInline: { type: "boolean" },
				},
			},
			Message: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					publicId: { type: "string" },
					mailboxId: { type: "string", format: "uuid" },
					threadId: { type: "string", format: "uuid" },
					messageId: { type: "string", description: "RFC 5322 Message-ID" },
					inReplyTo: { type: ["string", "null"] },
					references: { type: ["array", "null"], items: { type: "string" } },
					subject: { type: ["string", "null"] },
					snippet: { type: ["string", "null"] },
					from: ref("AddressObject"),
					to: ref("AddressObject"),
					cc: ref("AddressObject"),
					bcc: ref("AddressObject"),
					replyTo: { type: ["array", "null"] },
					date: { type: ["string", "null"], format: "date-time" },
					seen: { type: "boolean" },
					answered: { type: "boolean" },
					flagged: { type: "boolean" },
					draft: { type: "boolean" },
					hasAttachments: { type: "boolean" },
					text: { type: ["string", "null"], description: "includeText only" },
					textAsHtml: {
						type: ["string", "null"],
						description: "includeText only",
					},
					html: { type: ["string", "null"], description: "includeHtml only" },
					headers: {
						type: ["object", "null"],
						description: "includeHeaders only",
					},
					attachments: { type: "array", items: ref("Attachment") },
				},
			},
			AttachmentUpload: {
				type: "object",
				required: ["filename", "contentType", "content"],
				properties: {
					filename: { type: "string" },
					contentType: { type: "string" },
					content: { type: "string", description: "base64; 25 MB total" },
				},
			},
			EmailSendRequest: {
				type: "object",
				required: ["identityId", "to", "subject"],
				description: "Provide html or text (or both).",
				properties: {
					identityId: { type: "string", format: "uuid" },
					to: { type: "string", format: "email" },
					subject: { type: "string" },
					html: { type: "string" },
					text: { type: "string" },
					cc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string" } },
						],
					},
					bcc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string" } },
						],
					},
					attachments: { type: "array", items: ref("AttachmentUpload") },
					userEmail: {
						type: "string",
						format: "email",
						description: "Admin key only",
					},
				},
			},
			EmailReplyRequest: {
				type: "object",
				description:
					"Provide originalMessageId or threadId (latest readable message of the thread), and html or text.",
				properties: {
					originalMessageId: {
						type: "string",
						description: "Message uuid or publicId",
					},
					threadId: { type: "string", format: "uuid" },
					identityId: {
						type: "string",
						format: "uuid",
						description: "Defaults to the identity of the original's mailbox",
					},
					to: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string" } },
						],
						description: "Defaults to Reply-To, else From of the original",
					},
					cc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string" } },
						],
					},
					bcc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string" } },
						],
					},
					subject: {
						type: "string",
						description: 'Defaults to "Re: <original subject>"',
					},
					html: { type: "string" },
					text: { type: "string" },
					attachments: { type: "array", items: ref("AttachmentUpload") },
					userEmail: {
						type: "string",
						format: "email",
						description: "Admin key only",
					},
				},
			},
			EmailQueued: {
				type: "object",
				properties: {
					messageId: {
						type: "string",
						format: "uuid",
						description:
							"Id of the stored sent message once the worker has sent it",
					},
					originalMessageId: { type: "string", format: "uuid" },
					threadId: { type: "string", format: "uuid" },
					status: { const: "queued" },
				},
			},
		},
	},
} as const;
