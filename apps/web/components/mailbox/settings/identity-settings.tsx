"use client";
import { Button } from "@mantine/core";
import { ChevronRight, Cog } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

// Rendered as a single link (Mantine Button with component={Link}) instead
// of a <button> nested inside an <a>, which is invalid interactive nesting.
function IdentitySettingsLink({ identityLabel }: { identityLabel: string }) {
	const params = useParams();
	return (
		<Button
			component={Link}
			href={`/dashboard/mail/${params.identityPublicId}/settings`}
			size={"sm"}
			className={"!rounded-full"}
			leftSection={<Cog size={20} />}
			variant={"light"}
			rightSection={<ChevronRight size={16} />}
		>
			<span className={"font-medium"}>{identityLabel}</span>
		</Button>
	);
}

export default IdentitySettingsLink;
