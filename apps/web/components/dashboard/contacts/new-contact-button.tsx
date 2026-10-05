"use client";
import React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionIcon } from "@mantine/core";
import { useIsMobile } from "@/hooks/use-mobile";
import Link from "next/link";

export default function NewContactButton({
	hideOnMobile,
}: {
	hideOnMobile?: boolean;
}) {
	const isMobile = useIsMobile();

	return (
		<>
			{isMobile ? (
				<ActionIcon
					component={Link}
					href={"/dashboard/contacts/new"}
					aria-label="Create contact"
				>
					<Plus className="h-4 w-4" />
				</ActionIcon>
			) : (
				<Button asChild={true} hidden={!hideOnMobile} size="lg">
					<Link href={"/dashboard/contacts/new"}>
						<Plus className="h-5 w-5" />
						Create Contact
					</Link>
				</Button>
			)}
		</>
	);
}
