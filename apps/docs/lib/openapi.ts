export const kurrierOpenApiSpec = {
	openapi: "3.1.0",
	info: {
		title: "Kurrier API",
		version: "1.0.0",
		description:
			"HTTP+JSON API for reading mailboxes and messages, sending email, managing identities, and managing webhooks in Kurrier.",
	},
	servers: [
		{
			url: "https://your-domain.com/api/kurrier",
			description: "Your Kurrier instance",
		},
		{
			url: "https://kurrier.local.nothaft.cloud/api/kurrier",
			description: "Paul's local Kurrier instance",
		},
	],
	security: [{ bearerAuth: [] }],
	tags: [
		{ name: "Discovery" },
		{ name: "Me" },
		{ name: "Mailboxes" },
		{ name: "Messages" },
		{ name: "Email" },
		{ name: "Identities" },
		{ name: "Webhooks" },
	],
	paths: {
		"/": {
			get: {
				tags: ["Discovery"],
				summary: "Discover available API endpoints",
				security: [],
				responses: { "200": { description: "API discovery document" } },
			},
		},
		"/me": {
			get: {
				tags: ["Me"],
				summary: "Get authenticated API-key owner",
				responses: {
					"200": { description: "Authenticated user" },
					"401": { $ref: "#/components/responses/Unauthorized" },
				},
			},
		},
		"/mailboxes": {
			get: {
				tags: ["Mailboxes"],
				summary: "List identities with their mailboxes",
				description: "Requires `emails:receive`.",
				responses: {
					"200": { description: "Identity mailbox groups" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
		},
		"/mailboxes/overview": {
			get: {
				tags: ["Mailboxes"],
				summary: "Get mailbox overview with unread counters and recent threads",
				description: "Requires `emails:receive`.",
				responses: {
					"200": { description: "Mailbox overview" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
		},
		"/mailboxes/{mailboxId}/threads": {
			get: {
				tags: ["Mailboxes"],
				summary: "List threads for a mailbox",
				description: "Requires `emails:receive`.",
				parameters: [
					{ $ref: "#/components/parameters/MailboxId" },
					{ $ref: "#/components/parameters/Limit" },
				],
				responses: {
					"200": { description: "Mailbox threads" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
		},
		"/mailboxes/{mailboxId}/messages": {
			get: {
				tags: ["Messages"],
				summary: "List messages for a mailbox",
				description: "Requires `emails:receive`.",
				parameters: [
					{ $ref: "#/components/parameters/MailboxId" },
					{ $ref: "#/components/parameters/Limit" },
					{ $ref: "#/components/parameters/IncludeHtml" },
				],
				responses: {
					"200": { description: "Mailbox messages" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
		},
		"/threads/{threadId}/messages": {
			get: {
				tags: ["Messages"],
				summary: "List messages in a thread",
				description: "Requires `emails:receive`.",
				parameters: [
					{ $ref: "#/components/parameters/ThreadId" },
					{ $ref: "#/components/parameters/Limit" },
					{ $ref: "#/components/parameters/IncludeHtml" },
				],
				responses: {
					"200": { description: "Thread messages" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
		},
		"/messages": {
			get: {
				tags: ["Messages"],
				summary: "List recent messages",
				description: "Requires `emails:receive`.",
				parameters: [
					{ $ref: "#/components/parameters/Limit" },
					{ $ref: "#/components/parameters/IncludeHtml" },
					{
						name: "mailboxId",
						in: "query",
						schema: { type: "string", format: "uuid" },
						required: false,
					},
					{
						name: "threadId",
						in: "query",
						schema: { type: "string", format: "uuid" },
						required: false,
					},
				],
				responses: {
					"200": { description: "Recent messages" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
		},
		"/emails": {
			get: {
				tags: ["Messages"],
				summary: "Alias for listing recent messages",
				description: "Alias of `GET /messages`. Requires `emails:receive`.",
				parameters: [
					{ $ref: "#/components/parameters/Limit" },
					{ $ref: "#/components/parameters/IncludeHtml" },
				],
				responses: {
					"200": { description: "Recent messages" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
		},
		"/email/send": {
			post: {
				tags: ["Email"],
				summary: "Send a new email",
				description: "Requires `emails:send`.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/SendEmailRequest" },
						},
					},
				},
				responses: {
					"200": {
						description: "Email queued",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/MessageQueuedResponse" },
							},
						},
					},
					"400": { $ref: "#/components/responses/BadRequest" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
		},
		"/email/compose": {
			post: {
				tags: ["Email"],
				summary: "Compose and send a new email",
				description: "Alias of `POST /email/send`. Requires `emails:send`.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/SendEmailRequest" },
						},
					},
				},
				responses: {
					"200": { description: "Email queued" },
					"400": { $ref: "#/components/responses/BadRequest" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
		},
		"/email/reply": {
			post: {
				tags: ["Email"],
				summary: "Reply to an existing message or thread",
				description: "Requires `emails:send`.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ReplyEmailRequest" },
						},
					},
				},
				responses: {
					"200": { description: "Reply queued" },
					"400": { $ref: "#/components/responses/BadRequest" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
		},
		"/identities": {
			get: {
				tags: ["Identities"],
				summary: "List identities",
				description: "Requires `emails:receive` or `emails:send`.",
				responses: {
					"200": { description: "Identities" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
		},
		"/identities/{id}": {
			get: {
				tags: ["Identities"],
				summary: "Get an identity",
				parameters: [{ $ref: "#/components/parameters/Id" }],
				responses: {
					"200": { description: "Identity" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
			patch: {
				tags: ["Identities"],
				summary: "Update an identity",
				parameters: [{ $ref: "#/components/parameters/Id" }],
				responses: {
					"200": { description: "Updated identity" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
			delete: {
				tags: ["Identities"],
				summary: "Delete an identity",
				parameters: [{ $ref: "#/components/parameters/Id" }],
				responses: {
					"200": { description: "Deleted identity" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
		},
		"/webhooks": {
			get: {
				tags: ["Webhooks"],
				summary: "List webhooks",
				description: "Requires `emails:receive`.",
				responses: {
					"200": { description: "Webhooks" },
					"401": { $ref: "#/components/responses/Unauthorized" },
					"403": { $ref: "#/components/responses/Forbidden" },
				},
			},
			post: {
				tags: ["Webhooks"],
				summary: "Create a webhook",
				description: "Requires `emails:receive`.",
				responses: {
					"200": { description: "Created webhook" },
					"400": { $ref: "#/components/responses/BadRequest" },
				},
			},
		},
		"/webhooks/{id}": {
			get: {
				tags: ["Webhooks"],
				summary: "Get a webhook",
				parameters: [{ $ref: "#/components/parameters/Id" }],
				responses: {
					"200": { description: "Webhook" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
			patch: {
				tags: ["Webhooks"],
				summary: "Update a webhook",
				parameters: [{ $ref: "#/components/parameters/Id" }],
				responses: {
					"200": { description: "Updated webhook" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
			delete: {
				tags: ["Webhooks"],
				summary: "Delete a webhook",
				parameters: [{ $ref: "#/components/parameters/Id" }],
				responses: {
					"200": { description: "Deleted webhook" },
					"404": { $ref: "#/components/responses/NotFound" },
				},
			},
		},
	},
	components: {
		securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
		parameters: {
			Id: {
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string" },
			},
			MailboxId: {
				name: "mailboxId",
				in: "path",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
			ThreadId: {
				name: "threadId",
				in: "path",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
			Limit: {
				name: "limit",
				in: "query",
				required: false,
				schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
			},
			IncludeHtml: {
				name: "includeHtml",
				in: "query",
				required: false,
				schema: { type: "boolean", default: false },
			},
		},
		schemas: {
			AttachmentInput: {
				type: "object",
				required: ["filename", "contentType", "content"],
				properties: {
					filename: { type: "string" },
					contentType: { type: "string" },
					content: {
						type: "string",
						description: "Base64-encoded file content",
					},
				},
			},
			SendEmailRequest: {
				type: "object",
				required: ["identityId", "to", "subject"],
				anyOf: [{ required: ["html"] }, { required: ["text"] }],
				properties: {
					identityId: { type: "string" },
					to: { type: "string", format: "email" },
					subject: { type: "string" },
					html: { type: "string" },
					text: { type: "string" },
					cc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string", format: "email" } },
						],
					},
					bcc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string", format: "email" } },
						],
					},
					attachments: {
						type: "array",
						items: { $ref: "#/components/schemas/AttachmentInput" },
					},
				},
			},
			ReplyEmailRequest: {
				type: "object",
				anyOf: [
					{ required: ["originalMessageId"] },
					{ required: ["threadId"] },
				],
				properties: {
					originalMessageId: { type: "string", format: "uuid" },
					threadId: { type: "string", format: "uuid" },
					identityId: { type: "string", format: "uuid" },
					to: {
						oneOf: [
							{ type: "string", format: "email" },
							{ type: "array", items: { type: "string", format: "email" } },
						],
					},
					html: { type: "string" },
					text: { type: "string" },
					cc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string", format: "email" } },
						],
					},
					bcc: {
						oneOf: [
							{ type: "string" },
							{ type: "array", items: { type: "string", format: "email" } },
						],
					},
					attachments: {
						type: "array",
						items: { $ref: "#/components/schemas/AttachmentInput" },
					},
				},
			},
			MessageQueuedResponse: {
				type: "object",
				properties: {
					success: { type: "boolean" },
					data: {
						type: "object",
						properties: { messageId: { type: "string", format: "uuid" } },
					},
				},
			},
		},
		responses: {
			BadRequest: { description: "Invalid request" },
			Unauthorized: { description: "Missing or invalid API key" },
			Forbidden: { description: "API key does not have the required scope" },
			NotFound: { description: "Resource not found" },
		},
	},
} as const;
