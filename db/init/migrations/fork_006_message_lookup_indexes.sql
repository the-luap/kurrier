-- Fork: indexes for the per-message lookups of the IMAP sync worker.
-- Plain CREATE INDEX IF NOT EXISTS (see fork_004 for why not CONCURRENTLY);
-- on a large messages table this blocks writes to it while the index builds.
-- Mirrored in packages/db/src/drizzle/schema.ts (messages).

-- Delta sync looks up every fetched envelope by (owner_id, message_id), and
-- thread assignment looks up In-Reply-To / References the same way. The only
-- index on message_id leads with mailbox_id, so both were sequential scans.
CREATE INDEX IF NOT EXISTS "ix_messages_owner_message_id"
	ON "messages" USING btree ("owner_id", "message_id");

-- IDLE flag and expunge events resolve the message by mailbox + IMAP UID
-- (imap-idle-sync.ts: (meta -> 'imap' ->> 'uid')::bigint = $uid).
-- The expression must match that query exactly to be used.
CREATE INDEX IF NOT EXISTS "ix_messages_mailbox_imap_uid"
	ON "messages" USING btree ("mailbox_id", ((("meta" -> 'imap') ->> 'uid')::bigint));
