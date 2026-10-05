"use client";

import { useOptionalDictionary } from "@/components/providers/dictionary-provider";
import IsVerifiedStatus from "../providers/is-verified-status";

/**
 * Pure status badges. `incoming` is resolved by the parent from the identities
 * list it already has, instead of one client->server action call per row.
 */
function EmailIdentityStatus({ incoming }: { incoming: boolean }) {
	const dict = useOptionalDictionary();

	return (
		<>
			<IsVerifiedStatus
				verified={true}
				statusName={dict?.platform?.outgoing ?? "Outgoing"}
			/>
			<IsVerifiedStatus
				verified={incoming}
				statusName={dict?.platform?.incoming ?? "Incoming"}
			/>
		</>
	);
}

export default EmailIdentityStatus;
