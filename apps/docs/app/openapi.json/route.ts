import { kurrierOpenApiSpec } from "@/lib/openapi";

export function GET() {
	return Response.json(kurrierOpenApiSpec);
}
