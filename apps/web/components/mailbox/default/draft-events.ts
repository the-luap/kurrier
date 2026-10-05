import type { DraftPayload } from "@/lib/actions/mailbox";

// Shared between the drafts list (dispatches) and ComposeMail (listens). Kept
// in its own module so ComposeMail, which is rendered on every mail page,
// does not pull in the drafts list component.
export const OPEN_DRAFT_EVENT = "kurrier:open-draft";

export type OpenDraftDetail = {
	id: string;
	mailboxId: string;
	payload: DraftPayload;
};
