-- 020: indexes for frequent web queries (idempotent).

-- RLS adds owner_id = auth.uid() to every messages query; the dashboard
-- counts (total / last 24h) scanned the whole table.
CREATE INDEX IF NOT EXISTS "idx_messages_owner_created" ON "messages" USING btree ("owner_id","created_at");

-- Account-wide snoozed threads (sidebar counts, snoozed view).
CREATE INDEX IF NOT EXISTS "ix_mbth_owner_snoozed_until" ON "mailbox_threads" USING btree ("owner_id","snoozed_until") WHERE "mailbox_threads"."snoozed_until" IS NOT NULL;

-- Calendar invitation preview looks events up by iCal UID.
CREATE INDEX IF NOT EXISTS "ix_calendar_events_owner_ical_uid" ON "calendar_events" USING btree ("owner_id","ical_uid") WHERE "calendar_events"."ical_uid" IS NOT NULL;
