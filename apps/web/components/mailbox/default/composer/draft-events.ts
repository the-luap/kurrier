import type { DraftPayload } from "@/lib/actions/drafts";

// Shared between the drafts list (dispatches) and the compose launcher
// (listens). Kept in its own module so the launcher, rendered on every mail
// page, does not pull in the drafts list.
export const OPEN_DRAFT_EVENT = "kurrier:open-draft";

export type OpenDraftDetail = {
	id: string;
	payload: DraftPayload;
};

export type InitialDraft = OpenDraftDetail | null;
