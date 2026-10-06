#!/usr/bin/env python3
"""Migrate a legacy Supabase-based Kurrier database into an empty v4 database.

The target database must already contain the migrations from db/init/migrations.
The source is never modified. All target data changes run in one transaction.

Required environment variables:
  LEGACY_DATABASE_URL
  TARGET_DATABASE_URL
  APP_SECRET_ENCRYPTION_KEY

Optional:
  MIGRATED_SECRETS_FILE  JSON export already encrypted with the app key. This
                         is useful when a restored Supabase vault cannot be
                         decrypted outside its original cluster.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path
from collections.abc import Iterable
from typing import Any

import psycopg
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from psycopg import sql
from psycopg.rows import dict_row, tuple_row
from psycopg.types.json import Jsonb

EXPECTED_TARGET_MIGRATIONS = {
    "000_fork_reclaim_legacy_versions",
    "001_migration",
    "002_migration",
    "003_migration",
    "004_migration",
    "005_migration",
    "006_migration",
    "007_migration",
    "008_migration",
    "009_migration",
    "010_migration",
    "011_migration",
    "fork_001_user_ai_settings",
    "fork_002_signatures_from_identities",
    "fork_003_auth_users_legacy",
    "fork_004_indexes",
    "fork_005_draft_messages_indexes",
    "fork_006_message_lookup_indexes",
}

SKIP_GENERIC = {
    "migrations",
    "secrets_meta",
    "user_ai_settings",
}


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def qname(schema: str, table: str) -> sql.Composed:
    return sql.SQL("{}.{}").format(sql.Identifier(schema), sql.Identifier(table))


def column_info(conn: psycopg.Connection[Any], schema: str, table: str) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT column_name, data_type, udt_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
            """,
            (schema, table),
        )
        return list(cur.fetchall())


def table_names(conn: psycopg.Connection[Any], schema: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = %s ORDER BY tablename",
            (schema,),
        )
        return {row[0] for row in cur.fetchall()}


def adapt(value: Any, data_type: str) -> Any:
    if value is not None and data_type in {"json", "jsonb"}:
        return Jsonb(value)
    return value


def chunks(rows: list[tuple[Any, ...]], size: int = 500) -> Iterable[list[tuple[Any, ...]]]:
    for index in range(0, len(rows), size):
        yield rows[index : index + size]


def insert_rows(
    target: psycopg.Connection[Any],
    schema: str,
    table: str,
    columns: list[str],
    rows: list[tuple[Any, ...]],
    *,
    ignore_conflicts: bool = False,
) -> int:
    if not rows:
        return 0
    statement = sql.SQL("INSERT INTO {} ({}) VALUES ({}){}").format(
        qname(schema, table),
        sql.SQL(", ").join(map(sql.Identifier, columns)),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
        sql.SQL(" ON CONFLICT DO NOTHING") if ignore_conflicts else sql.SQL(""),
    )
    with target.cursor() as cur:
        for batch in chunks(rows):
            cur.executemany(statement, batch)
    return len(rows)


def workspace_uuid(user_id: uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"https://kurrier.app/legacy-workspace/{user_id}")


def workspace_public_id(user_id: uuid.UUID) -> str:
    raw = hashlib.sha256(f"kurrier:{user_id}".encode()).digest()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")[:10]


def encryption_key(raw: str) -> bytes:
    # Match packages/db/src/drizzle/vault.ts: Buffer.from(value), truncate/pad to 32.
    data = raw.encode()
    return data[:32].ljust(32, b"\0")


def encrypt_secret(plaintext: str, key: bytes) -> tuple[str, str, str]:
    iv = os.urandom(12)
    cipher = Cipher(algorithms.AES(key), modes.GCM(iv)).encryptor()
    ciphertext = cipher.update(plaintext.encode()) + cipher.finalize()
    return (
        base64.b64encode(ciphertext).decode(),
        base64.b64encode(iv).decode(),
        base64.b64encode(cipher.tag).decode(),
    )


def ensure_expected_databases(source: psycopg.Connection[Any], target: psycopg.Connection[Any]) -> None:
    with source.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "SELECT to_regclass('public.workspaces') AS workspaces, "
            "to_regclass('public.identities') AS identities"
        )
        relation_state = cur.fetchone()
        workspaces = relation_state["workspaces"]
        identities = relation_state["identities"]
        if workspaces is not None or identities is None:
            raise RuntimeError("source is not the expected Supabase-era Kurrier database")
        cur.execute(
            """
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema='auth' AND table_name='users'
                  AND column_name='encrypted_password'
            ) AS has_encrypted_password
            """
        )
        if not cur.fetchone()["has_encrypted_password"]:
            raise RuntimeError("source auth.users has no encrypted_password column")

    with target.cursor() as cur:
        cur.execute("SELECT version FROM public.migrations")
        versions = {row[0] for row in cur.fetchall()}
        if versions != EXPECTED_TARGET_MIGRATIONS:
            missing = sorted(EXPECTED_TARGET_MIGRATIONS - versions)
            extra = sorted(versions - EXPECTED_TARGET_MIGRATIONS)
            raise RuntimeError(f"target migrations mismatch: missing={missing}, extra={extra}")
        cur.execute("SELECT count(*) FROM auth.users")
        if cur.fetchone()[0] != 0:
            raise RuntimeError("target auth.users is not empty")
        cur.execute("SELECT count(*) FROM public.workspaces")
        if cur.fetchone()[0] != 0:
            raise RuntimeError("target workspaces is not empty")


def copy_users_and_workspaces(
    source: psycopg.Connection[Any], target: psycopg.Connection[Any]
) -> dict[uuid.UUID, uuid.UUID]:
    with source.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT id, email::text AS email, password_hash, encrypted_password, created_at
            FROM auth.users ORDER BY created_at, id
            """
        )
        users = list(cur.fetchall())
    if not users:
        raise RuntimeError("source has no users")

    with target.cursor() as cur:
        cur.execute("ALTER TABLE auth.users ALTER COLUMN password_hash DROP NOT NULL")
        cur.execute("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS encrypted_password text")

    insert_rows(
        target,
        "auth",
        "users",
        ["id", "email", "password_hash", "encrypted_password", "created_at"],
        [
            (
                user["id"],
                user["email"],
                user["password_hash"],
                user["encrypted_password"],
                user["created_at"],
            )
            for user in users
        ],
    )

    mapping = {user["id"]: workspace_uuid(user["id"]) for user in users}
    insert_rows(
        target,
        "public",
        "workspaces",
        ["id", "owner_id", "public_id", "name", "created_at", "updated_at"],
        [
            (
                mapping[user["id"]],
                user["id"],
                workspace_public_id(user["id"]),
                f"{str(user['email']).split('@', 1)[0]} Workspace",
                user["created_at"],
                user["created_at"],
            )
            for user in users
        ],
    )
    insert_rows(
        target,
        "public",
        "workspace_members",
        ["workspace_id", "user_id", "role", "created_at", "updated_at"],
        [
            (mapping[user["id"]], user["id"], "owner", user["created_at"], user["created_at"])
            for user in users
        ],
    )
    return mapping


def owner_maps(source: psycopg.Connection[Any]) -> tuple[dict[uuid.UUID, uuid.UUID], dict[uuid.UUID, uuid.UUID]]:
    with source.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT id, owner_id FROM providers")
        providers = dict(cur.fetchall())
        cur.execute("SELECT id, owner_id FROM smtp_accounts")
        smtp_accounts = dict(cur.fetchall())
    return providers, smtp_accounts


def copy_generic_tables(
    source: psycopg.Connection[Any],
    target: psycopg.Connection[Any],
    workspaces: dict[uuid.UUID, uuid.UUID],
) -> dict[str, int]:
    source_tables = table_names(source, "public")
    target_tables = table_names(target, "public")
    provider_owners, smtp_owners = owner_maps(source)
    with source.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT DISTINCT ON (owner_id) owner_id, id FROM address_books ORDER BY owner_id, created_at, id")
        default_address_books = dict(cur.fetchall())
    counts: dict[str, int] = {}

    for table in sorted((source_tables & target_tables) - SKIP_GENERIC):
        source_columns = {item["column_name"]: item for item in column_info(source, "public", table)}
        target_columns = {item["column_name"]: item for item in column_info(target, "public", table)}
        columns = [name for name in target_columns if name in source_columns]
        if table == "app_migrations":
            columns = [name for name in columns if name != "owner_id"]
        if not columns:
            continue

        with source.cursor(row_factory=dict_row) as cur:
            cur.execute(
                sql.SQL("SELECT {} FROM {} ORDER BY 1").format(
                    sql.SQL(", ").join(map(sql.Identifier, columns + (["owner_id"] if "workspace_id" in target_columns and "workspace_id" not in source_columns and "owner_id" not in columns and "owner_id" in source_columns else []))),
                    qname("public", table),
                )
            )
            source_rows = list(cur.fetchall())

        output_columns = list(columns)
        needs_workspace = "workspace_id" in target_columns and "workspace_id" not in source_columns
        if needs_workspace:
            output_columns.append("workspace_id")

        output_rows: list[tuple[Any, ...]] = []
        for row in source_rows:
            owner_id = row.get("owner_id")
            if needs_workspace and owner_id is None:
                if table == "provider_secrets":
                    owner_id = provider_owners.get(row.get("provider_id"))
                elif table == "smtp_account_secrets":
                    owner_id = smtp_owners.get(row.get("account_id"))
            if needs_workspace and owner_id not in workspaces:
                raise RuntimeError(f"cannot derive workspace for {table} row")
            values = []
            for name in columns:
                value = row[name]
                if table == "contacts" and name == "address_book_id" and value is None:
                    value = default_address_books.get(owner_id)
                    if value is None:
                        raise RuntimeError("contact owner has no address book")
                values.append(adapt(value, target_columns[name]["data_type"]))
            if needs_workspace:
                values.append(workspaces[owner_id])
            output_rows.append(tuple(values))

        insert_rows(
            target,
            "public",
            table,
            output_columns,
            output_rows,
            ignore_conflicts=table == "app_migrations",
        )
        counts[table] = len(output_rows)
    return counts


def copy_secrets(
    source: psycopg.Connection[Any],
    target: psycopg.Connection[Any],
    workspaces: dict[uuid.UUID, uuid.UUID],
    key: bytes,
) -> int:
    encrypted_export = os.environ.get("MIGRATED_SECRETS_FILE")
    if encrypted_export:
        rows = json.loads(Path(encrypted_export).read_text())
    else:
        with source.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT sm.id, sm.owner_id, sm.name, sm.description, ds.decrypted_secret
                FROM public.secrets_meta sm
                JOIN vault.decrypted_secrets ds ON ds.id = sm.vault_secret
                ORDER BY sm.id
                """
            )
            rows = list(cur.fetchall())
    encrypted_rows = []
    for row in rows:
        owner = uuid.UUID(str(row["owner_id"]))
        if owner not in workspaces:
            raise RuntimeError("secret owner has no workspace")
        if encrypted_export:
            encrypted_value, iv, auth_tag = row["encrypted_value"], row["iv"], row["auth_tag"]
        else:
            encrypted_value, iv, auth_tag = encrypt_secret(row["decrypted_secret"], key)
        encrypted_rows.append(
            (
                row["id"],
                owner,
                row["name"],
                row.get("description") or None,
                encrypted_value,
                iv,
                auth_tag,
                int(row.get("key_version", 1)),
                workspaces[owner],
                row.get("managed_by", "system"),
            )
        )
    insert_rows(
        target,
        "public",
        "secrets_meta",
        [
            "id",
            "owner_id",
            "name",
            "description",
            "encrypted_value",
            "iv",
            "auth_tag",
            "key_version",
            "workspace_id",
            "managed_by",
        ],
        encrypted_rows,
    )
    return len(encrypted_rows)


def copy_ai_settings(
    source: psycopg.Connection[Any],
    target: psycopg.Connection[Any],
    workspaces: dict[uuid.UUID, uuid.UUID],
    key: bytes,
) -> int:
    source_columns = {item["column_name"]: item for item in column_info(source, "public", "user_ai_settings")}
    target_columns = {item["column_name"]: item for item in column_info(target, "public", "user_ai_settings")}
    common = [name for name in target_columns if name in source_columns and name not in {"api_key", "api_key_secret_id"}]
    with source.cursor(row_factory=dict_row) as cur:
        cur.execute(
            sql.SQL("SELECT {}, api_key FROM public.user_ai_settings ORDER BY id").format(
                sql.SQL(", ").join(map(sql.Identifier, common))
            )
        )
        rows = list(cur.fetchall())
    output = []
    for row in rows:
        owner = row["owner_id"]
        secret_id = None
        if row.get("api_key"):
            secret_id = uuid.uuid4()
            encrypted_value, iv, auth_tag = encrypt_secret(row["api_key"], key)
            insert_rows(
                target,
                "public",
                "secrets_meta",
                ["id", "owner_id", "name", "encrypted_value", "iv", "auth_tag", "key_version", "workspace_id", "managed_by"],
                [(secret_id, owner, f"ai:{owner}:{row['provider']}", encrypted_value, iv, auth_tag, 1, workspaces[owner], "system")],
            )
        values = [adapt(row[name], target_columns[name]["data_type"]) for name in common]
        values += [workspaces[owner], secret_id]
        output.append(tuple(values))
    insert_rows(target, "public", "user_ai_settings", common + ["workspace_id", "api_key_secret_id"], output)
    return len(output)


def migrate_signatures(source: psycopg.Connection[Any], target: psycopg.Connection[Any], workspaces: dict[uuid.UUID, uuid.UUID]) -> int:
    with source.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT id, owner_id, signature_html
            FROM identities
            WHERE coalesce(btrim(signature_html), '') <> ''
            ORDER BY id
            """
        )
        rows = list(cur.fetchall())
    output = []
    for row in rows:
        document = {
            "version": 1,
            "settings": {
                "contentWidth": 600,
                "backgroundColor": "#f3f4f6",
                "contentBackgroundColor": "#ffffff",
                "fontFamily": "Arial, sans-serif",
                "textColor": "#111827",
            },
            "blocks": [
                {
                    "id": str(uuid.uuid4()),
                    "type": "text",
                    "content": row["signature_html"],
                    "styles": {
                        "color": "#111827",
                        "fontSize": 14,
                        "lineHeight": 1.5,
                        "textAlign": "left",
                        "padding": {"top": 0, "right": 0, "bottom": 0, "left": 0},
                    },
                }
            ],
        }
        output.append(
            (
                workspaces[row["owner_id"]],
                row["owner_id"],
                row["id"],
                "Signature",
                Jsonb(document),
                True,
                True,
                Jsonb({"migratedFrom": "identities.signature_html"}),
            )
        )
    insert_rows(
        target,
        "public",
        "email_signatures",
        ["workspace_id", "owner_id", "identity_id", "name", "document", "is_default_for_new", "is_default_for_reply_forward", "meta"],
        output,
        ignore_conflicts=True,
    )
    return len(output)


def set_default_identities(target: psycopg.Connection[Any]) -> None:
    with target.cursor() as cur:
        cur.execute(
            """
            UPDATE workspaces w
            SET default_identity_id = (
                SELECT i.id
                FROM identities i
                WHERE i.workspace_id = w.id AND i.kind = 'email'
                ORDER BY (i.status = 'verified') DESC, i.created_at, i.id
                LIMIT 1
            ), updated_at = now()
            WHERE w.default_identity_id IS NULL
              AND EXISTS (
                SELECT 1 FROM identities i
                WHERE i.workspace_id = w.id AND i.kind = 'email'
              )
            """
        )


def validate_foreign_keys(target: psycopg.Connection[Any]) -> None:
    with target.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT ns.nspname AS schema_name, rel.relname AS table_name,
                   c.conname, rns.nspname AS ref_schema, ref.relname AS ref_table,
                   array_agg(a.attname ORDER BY x.ord) AS columns,
                   array_agg(ra.attname ORDER BY x.ord) AS ref_columns
            FROM pg_constraint c
            JOIN pg_class rel ON rel.oid=c.conrelid
            JOIN pg_namespace ns ON ns.oid=rel.relnamespace
            JOIN pg_class ref ON ref.oid=c.confrelid
            JOIN pg_namespace rns ON rns.oid=ref.relnamespace
            JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY x(attnum, refattnum, ord) ON true
            JOIN pg_attribute a ON a.attrelid=rel.oid AND a.attnum=x.attnum
            JOIN pg_attribute ra ON ra.attrelid=ref.oid AND ra.attnum=x.refattnum
            WHERE c.contype='f' AND ns.nspname IN ('public','auth')
            GROUP BY ns.nspname, rel.relname, c.conname, rns.nspname, ref.relname
            ORDER BY 1,2,3
            """
        )
        constraints = list(cur.fetchall())
    with target.cursor() as cur:
        for item in constraints:
            joins = sql.SQL(" AND ").join(
                sql.SQL("src.{} = ref.{}").format(sql.Identifier(col), sql.Identifier(ref_col))
                for col, ref_col in zip(item["columns"], item["ref_columns"], strict=True)
            )
            present = sql.SQL(" AND ").join(
                sql.SQL("src.{} IS NOT NULL").format(sql.Identifier(col)) for col in item["columns"]
            )
            check = sql.SQL("SELECT count(*) FROM {} src LEFT JOIN {} ref ON {} WHERE ({}) AND ref.{} IS NULL").format(
                qname(item["schema_name"], item["table_name"]),
                qname(item["ref_schema"], item["ref_table"]),
                joins,
                present,
                sql.Identifier(item["ref_columns"][0]),
            )
            cur.execute(check)
            orphan_count = cur.fetchone()[0]
            if orphan_count:
                raise RuntimeError(f"foreign-key orphan: {item['conname']} has {orphan_count} rows")


def validate_counts(
    source: psycopg.Connection[Any], target: psycopg.Connection[Any], copied: dict[str, int]
) -> None:
    with target.cursor() as cur:
        for table, expected in copied.items():
            if table == "app_migrations":
                continue
            cur.execute(sql.SQL("SELECT count(*) FROM {}").format(qname("public", table)))
            actual = cur.fetchone()[0]
            if actual != expected:
                raise RuntimeError(f"row-count mismatch for {table}: source={expected}, target={actual}")
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema='public' AND column_name='workspace_id'
            GROUP BY table_name
            HAVING EXISTS (
                SELECT 1 FROM information_schema.columns c2
                WHERE c2.table_schema='public' AND c2.table_name=information_schema.columns.table_name
            )
            """
        )
        workspace_tables = [row[0] for row in cur.fetchall()]
        for table in workspace_tables:
            cur.execute(sql.SQL("SELECT count(*) FROM {} WHERE workspace_id IS NULL").format(qname("public", table)))
            if cur.fetchone()[0]:
                raise RuntimeError(f"NULL workspace_id remains in {table}")


def main() -> int:
    source_url = required_env("LEGACY_DATABASE_URL")
    target_url = required_env("TARGET_DATABASE_URL")
    key = encryption_key(required_env("APP_SECRET_ENCRYPTION_KEY"))

    with psycopg.connect(source_url, row_factory=dict_row) as source, psycopg.connect(target_url) as target:
        source.execute("SET TRANSACTION READ ONLY")
        ensure_expected_databases(source, target)
        target.execute("SET LOCAL session_replication_role = replica")

        workspaces = copy_users_and_workspaces(source, target)
        secret_count = copy_secrets(source, target, workspaces, key)
        copied = copy_generic_tables(source, target, workspaces)
        ai_count = copy_ai_settings(source, target, workspaces, key)
        signature_count = migrate_signatures(source, target, workspaces)
        set_default_identities(target)

        target.execute("SET LOCAL session_replication_role = origin")
        validate_foreign_keys(target)
        validate_counts(source, target, copied)
        target.commit()

    print(f"users={len(workspaces)}")
    print(f"secrets={secret_count}")
    print(f"ai_settings={ai_count}")
    print(f"signatures={signature_count}")
    for table, count in sorted(copied.items()):
        print(f"{table}={count}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"migration failed: {exc}", file=sys.stderr)
        raise
