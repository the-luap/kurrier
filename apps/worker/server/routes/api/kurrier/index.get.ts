import { defineEventHandler } from "h3";

export default defineEventHandler(() => {
	const baseUrl = "/api/kurrier";

	return {
		success: true,
		data: {
			name: "Kurrier API",
			version: "v1",
			baseUrl,
			authentication: {
				type: "bearer",
				header: "Authorization: Bearer <api-key>",
				apiKeysDashboard: "/dashboard/platform/api-keys",
			},
			scopes: {
				"emails:receive":
					"Read mailboxes, threads, messages, identities and webhooks",
				"emails:send": "Compose, send and reply to emails",
			},
			endpoints: {
				discovery: [{ method: "GET", path: "/api/kurrier" }],
				mailboxes: [
					{
						method: "GET",
						path: "/api/kurrier/mailboxes",
						scope: "emails:receive",
					},
					{
						method: "GET",
						path: "/api/kurrier/mailboxes/overview",
						scope: "emails:receive",
					},
					{
						method: "GET",
						path: "/api/kurrier/mailboxes/:id/threads?limit=50",
						scope: "emails:receive",
					},
				],
				messages: [
					{
						method: "GET",
						path: "/api/kurrier/threads/:id/messages?limit=50&includeHtml=true",
						scope: "emails:receive",
					},
				],
				email: [
					{
						method: "POST",
						path: "/api/kurrier/email/send",
						scope: "emails:send",
					},
					{
						method: "POST",
						path: "/api/kurrier/email/compose",
						scope: "emails:send",
					},
					{
						method: "POST",
						path: "/api/kurrier/email/reply",
						scope: "emails:send",
					},
				],
				identities: [
					{
						method: "GET",
						path: "/api/kurrier/identities",
						scope: "emails:receive or emails:send",
					},
					{
						method: "GET",
						path: "/api/kurrier/identities/:id",
						scope: "emails:receive or emails:send",
					},
					{
						method: "PATCH",
						path: "/api/kurrier/identities/:id",
						scope: "emails:receive or emails:send",
					},
					{
						method: "DELETE",
						path: "/api/kurrier/identities/:id",
						scope: "emails:receive or emails:send",
					},
				],
				webhooks: [
					{
						method: "GET",
						path: "/api/kurrier/webhooks",
						scope: "emails:receive",
					},
					{
						method: "POST",
						path: "/api/kurrier/webhooks",
						scope: "emails:receive",
					},
					{
						method: "GET",
						path: "/api/kurrier/webhooks/:id",
						scope: "emails:receive",
					},
					{
						method: "PATCH",
						path: "/api/kurrier/webhooks/:id",
						scope: "emails:receive",
					},
					{
						method: "DELETE",
						path: "/api/kurrier/webhooks/:id",
						scope: "emails:receive",
					},
				],
			},
		},
	};
});
