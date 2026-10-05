import React from "react";
import IsVerifiedStatus from "../providers/is-verified-status";

/**
 * Pure status badges. `incoming` is resolved by the parent from the identities
 * list it already has, instead of one client->server action call per row.
 */
function EmailIdentityStatus({ incoming }: { incoming: boolean }) {
	return (
		<>
			<IsVerifiedStatus verified={true} statusName="Outgoing" />
			<IsVerifiedStatus verified={incoming} statusName="Incoming" />
		</>
	);
}

export default EmailIdentityStatus;
