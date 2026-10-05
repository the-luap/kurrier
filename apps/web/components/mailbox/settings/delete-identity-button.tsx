"use client";

import { Button } from "@mantine/core";
import { modals } from "@mantine/modals";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { responsiveModalActionsClassName } from "@/components/common/modal-actions";
import {
	deleteEmailIdentity,
	type FetchUserIdentitiesResult,
} from "@/lib/actions/dashboard";

type Labels = {
	button: string;
	title: string;
	confirmPrefix: string;
	confirmSuffix: string;
	confirm: string;
	cancel: string;
	failed: string;
};

/**
 * Danger zone "Delete identity": same confirm + server action as the
 * platform identities page (the action reloads the identity from the
 * caller's workspace and requires owner/admin).
 */
export default function DeleteIdentityButton({
	identityId,
	identityValue,
	redirectTo,
	labels,
}: {
	identityId: string;
	identityValue: string;
	redirectTo: string;
	labels: Labels;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();

	const onClick = () =>
		modals.openConfirmModal({
			title: (
				<div className="font-semibold text-brand-foreground">{labels.title}</div>
			),
			centered: true,
			children: (
				<div className="text-sm">
					{labels.confirmPrefix}
					<b>{identityValue}</b>
					{labels.confirmSuffix}
				</div>
			),
			labels: { confirm: labels.confirm, cancel: labels.cancel },
			confirmProps: { color: "red" },
			groupProps: { className: responsiveModalActionsClassName },
			onConfirm: () =>
				startTransition(async () => {
					// Only the id is read by the action.
					const res: { success: boolean; message?: string; error?: string } =
						await deleteEmailIdentity({
							identities: { id: identityId },
						} as FetchUserIdentitiesResult[number]);
					if (res?.success) {
						toast.success(res.message ?? labels.title);
						router.push(redirectTo);
						router.refresh();
					} else {
						toast.error(labels.failed, {
							description: res?.error ?? res?.message ?? undefined,
						});
					}
				}),
		});

	return (
		<Button
			color="red"
			leftSection={<Trash2 size={16} />}
			onClick={onClick}
			loading={pending}
		>
			{labels.button}
		</Button>
	);
}
