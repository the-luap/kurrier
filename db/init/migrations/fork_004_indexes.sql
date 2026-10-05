-- Fork: index equivalents of the Supabase-fork 020 index migration, adapted to
-- the v4 RLS model (policies filter on workspace_id, not owner_id).
-- Plain CREATE INDEX (not CONCURRENTLY) so a failed run never leaves an
-- INVALID index that IF NOT EXISTS would then skip; it blocks writes to the
-- table while building, which is short on single-tenant installs.

-- Dashboard message counts (total / last 24h) per workspace.
CREATE INDEX IF NOT EXISTS "ix_messages_workspace_created" ON "messages" USING btree ("workspace_id", "created_at");

-- Account-wide snoozed view / sidebar counts (fetchIdentitySnoozedThreads scans all
-- snoozed threads visible in the workspace).
CREATE INDEX IF NOT EXISTS "ix_mbth_workspace_snoozed_until" ON "mailbox_threads" USING btree ("workspace_id", "snoozed_until") WHERE "mailbox_threads"."snoozed_until" IS NOT NULL;

-- Calendar invitation preview looks events up by iCal UID across calendars.
CREATE INDEX IF NOT EXISTS "ix_calendar_events_workspace_ical_uid" ON "calendar_events" USING btree ("workspace_id", "ical_uid") WHERE "calendar_events"."ical_uid" IS NOT NULL;
