import { getServerEnv } from "@schema";
import Typesense from "typesense";

const {
	TYPESENSE_API_KEY,
	TYPESENSE_PORT,
	TYPESENSE_PROTOCOL,
	TYPESENSE_HOST,
} = getServerEnv();

const client = new Typesense.Client({
	nodes: [
		{
			host: TYPESENSE_HOST,
			port: Number(TYPESENSE_PORT),
			protocol: TYPESENSE_PROTOCOL,
		},
	],
	apiKey: TYPESENSE_API_KEY,
	// The 5s default is too short for bulk imports of full message bodies;
	// a timeout made the client retry (re-send) the whole import.
	connectionTimeoutSeconds: 60,
});

export default client;
