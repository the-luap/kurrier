import { kurrierOpenApiSpec } from "@/lib/openapi";

export const revalidate = false;

export function GET() {
	return Response.json(kurrierOpenApiSpec, {
		headers: { "Access-Control-Allow-Origin": "*" },
	});
}
