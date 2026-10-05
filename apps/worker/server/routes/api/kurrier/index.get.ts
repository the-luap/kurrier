import { defineEventHandler } from "h3";

type Endpoint = {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	scope: string | null;
	description: string;
	alias?: string;
};

const READ = "emails:receive";
const SEND = "emails:send";
const MANAGE = "emails:send or emails:receive";
const ADMIN = "admin API key";

const endpoints: Record<string, Endpoint[]> = {
	discovery: [
		{
			method: "GET",
			path: "/api/kurrier",
			scope: null,
			description: "This list (no authentication required)",
		},
	],
	me: [
		{
			method: "GET",
			path: "/api/kurrier/me",
			scope: MANAGE,
			description: "The user the API key belongs to",
		},
	],
	mailboxes: [
		{
			method: "GET",
			path: "/api/kurrier/mailboxes?identityId=",
			scope: READ,
			description: "Readable email identities with their mailboxes",
		},
		{
			method: "GET",
			path: "/api/kurrier/mailboxes/overview",
			scope: READ,
			description: "Mailboxes with unread counts and recent unread threads",
		},
		{
			method: "GET",
			path: "/api/kurrier/identities/:id/mailboxes",
			scope: READ,
			description: "Mailboxes of one identity",
		},
		{
			method: "GET",
			path: "/api/kurrier/mailboxes/:id/threads?limit=50&offset=0&unread=true",
			scope: READ,
			description: "Threads of a mailbox, newest first",
		},
		{
			method: "GET",
			path: "/api/kurrier/mailboxes/:id/messages?limit=50&offset=0&includeHtml=true&includeText=true",
			scope: READ,
			description: "Messages of a mailbox, newest first",
		},
	],
	messages: [
		{
			method: "GET",
			path: "/api/kurrier/messages?mailboxId=&threadId=&unread=true&limit=50&offset=0&includeHtml=true&includeText=true",
			scope: READ,
			description: "Messages across all readable mailboxes",
			alias: "/api/kurrier/emails",
		},
		{
			method: "GET",
			path: "/api/kurrier/messages/:id",
			scope: READ,
			description: "One message (uuid or publicId) with bodies",
			alias: "/api/kurrier/emails/:id",
		},
		{
			method: "GET",
			path: "/api/kurrier/threads/:id/messages?limit=50&offset=0&includeHtml=true&includeText=true",
			scope: READ,
			description: "Messages of a thread, oldest first",
		},
	],
	email: [
		{
			method: "POST",
			path: "/api/kurrier/email/send",
			scope: SEND,
			description: "Send a new message",
			alias: "/api/kurrier/email/compose",
		},
		{
			method: "POST",
			path: "/api/kurrier/email/reply",
			scope: SEND,
			description: "Reply to a message or thread",
		},
	],
	inbound: [
		{
			method: "POST",
			path: "/api/kurrier/inbound",
			scope: MANAGE,
			description:
				"Ingest a raw RFC822 message for an inbound identity (X-Kurrier-Identity header)",
		},
	],
	identities: [
		{
			method: "GET",
			path: "/api/kurrier/identities",
			scope: MANAGE,
			description: "List identities",
		},
		{
			method: "POST",
			path: "/api/kurrier/identities",
			scope: MANAGE,
			description: "Create an SMTP identity",
		},
		{
			method: "GET",
			path: "/api/kurrier/identities/:id",
			scope: MANAGE,
			description: "Get an identity",
		},
		{
			method: "PATCH",
			path: "/api/kurrier/identities/:id",
			scope: MANAGE,
			description: "Update an identity",
		},
		{
			method: "DELETE",
			path: "/api/kurrier/identities/:id",
			scope: MANAGE,
			description: "Delete an identity",
		},
	],
	smtpAccounts: [
		{
			method: "GET",
			path: "/api/kurrier/smtp-accounts",
			scope: MANAGE,
			description: "List SMTP accounts",
		},
		{
			method: "POST",
			path: "/api/kurrier/smtp-accounts",
			scope: MANAGE,
			description: "Create an SMTP account",
		},
		{
			method: "GET",
			path: "/api/kurrier/smtp-accounts/:id",
			scope: MANAGE,
			description: "Get an SMTP account",
		},
		{
			method: "PATCH",
			path: "/api/kurrier/smtp-accounts/:id",
			scope: MANAGE,
			description: "Update an SMTP account",
		},
		{
			method: "DELETE",
			path: "/api/kurrier/smtp-accounts/:id",
			scope: MANAGE,
			description: "Delete an SMTP account",
		},
	],
	webhooks: [
		{
			method: "GET",
			path: "/api/kurrier/webhooks",
			scope: MANAGE,
			description: "List webhooks",
		},
		{
			method: "POST",
			path: "/api/kurrier/webhooks",
			scope: MANAGE,
			description: "Create a webhook",
		},
		{
			method: "GET",
			path: "/api/kurrier/webhooks/:id",
			scope: MANAGE,
			description: "Get a webhook",
		},
		{
			method: "PATCH",
			path: "/api/kurrier/webhooks/:id",
			scope: MANAGE,
			description: "Update a webhook",
		},
		{
			method: "DELETE",
			path: "/api/kurrier/webhooks/:id",
			scope: MANAGE,
			description: "Delete a webhook",
		},
	],
	users: [
		{
			method: "POST",
			path: "/api/kurrier/users",
			scope: ADMIN,
			description: "Provision a user (admin API key only)",
		},
	],
};

// GET /api/kurrier
// Standalone, unauthenticated discovery document listing the API routes.
export default defineEventHandler(() => ({
	success: true,
	data: {
		name: "Kurrier API",
		version: "v1",
		baseUrl: "/api/kurrier",
		authentication: {
			type: "bearer",
			header: "Authorization: Bearer <api-key>",
			apiKeysDashboard: "Dashboard → Platform → API keys",
			adminKey:
				"API_ADMIN_KEY (env) acts for the user given by userEmail (body or query)",
		},
		scopes: {
			"emails:receive": "Read mailboxes, threads and messages",
			"emails:send": "Send, compose and reply to emails",
			note: "Scopes are enforced only when the API key has a non-empty scopes list. Management routes accept either email scope.",
		},
		pagination: {
			limit: "1-100, default 50",
			offset:
				"0-10000; responses carry pagination.nextOffset (null on the last page)",
		},
		documentation: "https://www.kurrier.org/docs/api/authentication",
		openapi: "https://www.kurrier.org/openapi.json",
		endpoints,
	},
}));
