"use client";

import { Button, Textarea } from "@mantine/core";
import type { FormState } from "@schema";
import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { updateIdentitySignature } from "@/lib/actions/dashboard";

type Props = {
	identityId: string;
	identityValue: string;
	defaultSignature?: string | null;
	onCompleted?: () => void;
};

export default function IdentitySignatureForm({
	identityId,
	identityValue,
	defaultSignature,
	onCompleted,
}: Props) {
	const [signature, setSignature] = useState(defaultSignature ?? "");

	const [formState, formAction, isPending] = useActionState<
		FormState,
		FormData
	>(updateIdentitySignature, {});

	useEffect(() => {
		if (formState.error) {
			toast.error("Could not save signature", {
				description: formState.error,
			});
		} else if (formState.success) {
			toast.success(formState.message || "Signature saved");
			onCompleted?.();
		}
	}, [formState, onCompleted]);

	return (
		<form action={formAction} className="space-y-4">
			<input type="hidden" name="identityId" value={identityId} />

			<div className="space-y-1">
				<p className="text-sm text-muted-foreground">
					This signature is attached to <strong>{identityValue}</strong> and is
					inserted automatically when composing, replying, or forwarding from
					this mailbox.
				</p>
				<p className="text-xs text-muted-foreground">
					HTML is supported for links and formatting. Keep scripts out — this is
					email, not a browser circus.
				</p>
			</div>

			<Textarea
				name="signatureHtml"
				label="Signature HTML"
				placeholder={"<p>Best regards,<br/>Paul</p>"}
				value={signature}
				onChange={(event) => setSignature(event.currentTarget.value)}
				minRows={8}
				maxRows={16}
				autosize
			/>

			<div className="rounded-md border bg-muted/30 p-3">
				<div className="text-xs font-medium text-muted-foreground mb-2">
					HTML source
				</div>
				<pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
					{signature || "No signature yet."}
				</pre>
			</div>

			<div className="flex justify-end gap-2">
				<Button type="submit" loading={isPending}>
					Save Signature
				</Button>
			</div>
		</form>
	);
}
