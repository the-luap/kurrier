-- Fork: composite indexes for the draft queries added by the fork ports.
-- Plain CREATE INDEX IF NOT EXISTS (see fork_004 for why not CONCURRENTLY).
-- Mirrored in packages/db/src/drizzle/schema.ts (draftMessages).

-- Autosaved drafts of the current user, newest first
-- (drafts.ts: owner_id = ? AND status = 'draft' ORDER BY updated_at DESC).
CREATE INDEX IF NOT EXISTS "ix_draft_messages_owner_status_updated"
	ON "draft_messages" USING btree ("owner_id", "status", "updated_at");

-- RLS filters every draft query on workspace_id (no index on it so far);
-- dashboard / sidebar counts additionally filter on status.
CREATE INDEX IF NOT EXISTS "ix_draft_messages_workspace_status"
	ON "draft_messages" USING btree ("workspace_id", "status");

-- Scheduled sends of one identity (status = 'scheduled' AND identity_id = ?).
CREATE INDEX IF NOT EXISTS "ix_draft_messages_identity_status"
	ON "draft_messages" USING btree ("identity_id", "status");
