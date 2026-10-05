-- Fork: move the v3-fork per-identity signature (identities.signature_html)
-- into upstream's email_signatures table (added by upstream 009_migration).
-- One "Signature" row per identity, wrapped as a single text block of an
-- EmailDocument (version 1). It becomes the default for new mail and for
-- reply/forward unless the identity already has such a default.
-- No-op on installs that never had the column. The column itself is kept
-- (drop it in a later fork migration once the port is verified).

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'identities'
			AND column_name = 'signature_html'
	) THEN
		RETURN;
	END IF;

	EXECUTE $sql$
		INSERT INTO "email_signatures" (
			"workspace_id", "owner_id", "identity_id", "name", "document",
			"is_default_for_new", "is_default_for_reply_forward", "meta"
		)
		SELECT
			i.workspace_id,
			i.owner_id,
			i.id,
			'Signature',
			jsonb_build_object(
				'version', 1,
				'settings', jsonb_build_object(
					'contentWidth', 600,
					'backgroundColor', '#f3f4f6',
					'contentBackgroundColor', '#ffffff',
					'fontFamily', 'Arial, sans-serif',
					'textColor', '#111827'
				),
				'blocks', jsonb_build_array(jsonb_build_object(
					'id', gen_random_uuid()::text,
					'type', 'text',
					'content', i.signature_html,
					'styles', jsonb_build_object(
						'color', '#111827',
						'fontSize', 14,
						'lineHeight', 1.5,
						'textAlign', 'left',
						'padding', jsonb_build_object('top', 0, 'right', 0, 'bottom', 0, 'left', 0)
					)
				))
			),
			NOT EXISTS (
				SELECT 1 FROM "email_signatures" s
				WHERE s.identity_id = i.id AND s.is_default_for_new
			),
			NOT EXISTS (
				SELECT 1 FROM "email_signatures" s
				WHERE s.identity_id = i.id AND s.is_default_for_reply_forward
			),
			jsonb_build_object('migratedFrom', 'identities.signature_html')
		FROM "identities" i
		WHERE i.signature_html IS NOT NULL
			AND btrim(i.signature_html) <> ''
			-- manual re-run: do not re-create a migrated signature the user
			-- has since renamed or edited
			AND NOT EXISTS (
				SELECT 1 FROM "email_signatures" s
				WHERE s.identity_id = i.id
					AND s.meta ->> 'migratedFrom' = 'identities.signature_html'
			)
		ON CONFLICT ("identity_id", "name") DO NOTHING
	$sql$;
END
$$;
