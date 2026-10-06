#!/usr/bin/env python3
"""Copy Supabase local-storage objects into Kurrier's v4 S3 bucket.

The source volume is read-only. Existing destination objects with the same size
are left untouched. The final pass verifies every source key by size.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def source_objects(root: Path):
    storage_root = root / "stub"
    if not storage_root.is_dir():
        raise RuntimeError(f"Supabase storage root not found: {storage_root}")
    seen: set[str] = set()
    for bucket in sorted(path for path in storage_root.iterdir() if path.is_dir()):
        for source in sorted(path for path in bucket.rglob("*") if path.is_file()):
            key = source.relative_to(bucket).as_posix()
            if key in seen:
                raise RuntimeError(f"duplicate key across Supabase buckets: {key}")
            seen.add(key)
            yield source, key, source.stat().st_size


def main() -> int:
    root = Path(os.environ.get("SOURCE_ROOT", "/source"))
    endpoint = required("S3_ENDPOINT")
    access_key = required("S3_ACCESS_KEY")
    secret_key = required("S3_SECRET_KEY")
    bucket = required("S3_BUCKET")

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.environ.get("S3_REGION", "garage"),
        config=Config(
            signature_version="s3v4",
            connect_timeout=30,
            read_timeout=600,
            retries={"max_attempts": 10, "mode": "standard"},
            s3={"addressing_style": "path"},
        ),
    )

    objects = list(source_objects(root))
    uploaded = skipped = source_bytes = 0
    for source, key, size in objects:
        source_bytes += size
        try:
            head = client.head_object(Bucket=bucket, Key=key)
            if int(head["ContentLength"]) == size:
                skipped += 1
                if (uploaded + skipped) % 100 == 0:
                    print(f"processed={uploaded + skipped}/{len(objects)}", flush=True)
                continue
        except ClientError as error:
            status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if status != 404 and error.response.get("Error", {}).get("Code") not in {"404", "NoSuchKey", "NotFound"}:
                raise
        content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        client.upload_file(
            str(source),
            bucket,
            key,
            ExtraArgs={"ContentType": content_type},
            Config=TransferConfig(
                multipart_threshold=64 * 1024 * 1024,
                multipart_chunksize=16 * 1024 * 1024,
                max_concurrency=1,
                use_threads=False,
            ),
        )
        uploaded += 1
        if (uploaded + skipped) % 100 == 0:
            print(f"processed={uploaded + skipped}/{len(objects)}", flush=True)

    verified = verified_bytes = 0
    for _source, key, size in objects:
        head = client.head_object(Bucket=bucket, Key=key)
        if int(head["ContentLength"]) != size:
            raise RuntimeError(f"size mismatch after upload for one object")
        verified += 1
        verified_bytes += size

    print(f"source_objects={len(objects)}")
    print(f"source_bytes={source_bytes}")
    print(f"uploaded={uploaded}")
    print(f"skipped_same_size={skipped}")
    print(f"verified_objects={verified}")
    print(f"verified_bytes={verified_bytes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
