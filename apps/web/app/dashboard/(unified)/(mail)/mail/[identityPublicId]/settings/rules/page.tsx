import React from "react";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import CreateMailRuleForm from "@/components/mailbox/settings/rules/create-rule-form";
import {
	createRule,
	fetchMailRules,
	getAppLabels,
} from "@/lib/actions/mail-rules";
import { getIdentityByPublicId } from "@/components/mailbox/identity-by-public-id";
import MailRulesList from "@/components/mailbox/settings/rules/mail-rules-list";
import { Divider } from "@mantine/core";

async function Page({ params }: { params: { identityPublicId: string } }) {
	const resolvedParams = await params;
	const identity = await getIdentityByPublicId(resolvedParams.identityPublicId);

	if (!identity) {
		return (
			<SectionCard
				title="Rules"
				description="Create filters to automatically process incoming mail."
			>
				<div className="text-sm text-neutral-600 dark:text-neutral-400">
					Identity not found.
				</div>
			</SectionCard>
		);
	}

	const [appLabels, rules] = await Promise.all([
		getAppLabels(),
		fetchMailRules(identity.id),
	]);

	return (
		<SectionCard
			title={"Rules"}
			description={"Create filters to automatically process incoming mail."}
		>
			<MailRulesList rules={rules} />
			{rules.length > 0 && (
				<Divider
					my={"xl"}
					variant={"dashed"}
					label={<span className={"text-sm"}>Add New Label</span>}
					labelPosition={"left"}
				/>
			)}
			<CreateMailRuleForm
				identityId={identity.id}
				action={createRule}
				appLabels={appLabels}
			/>
		</SectionCard>
	);
}

export default Page;
