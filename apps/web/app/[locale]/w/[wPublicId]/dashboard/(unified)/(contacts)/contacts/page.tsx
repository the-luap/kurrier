import ContactSelectionPlaceholder from "@/components/dashboard/contacts/contact-selection-placeholder";
import { getDictionary } from "@/lib/dictionaries";

export default async function Page({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	// The URL's locale, like the rest of the page (the cookie may differ).
	const { locale } = await params;
	const dict = await getDictionary(locale);

	return (
		<ContactSelectionPlaceholder
			title={dict.contacts.selectContactTitle}
			description={dict.contacts.pleaseSelectAContact}
		/>
	);
}
