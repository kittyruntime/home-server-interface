#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cd "$root/packages/database"
DATABASE_URL="file:$tmp/from-migrations.db" pnpm exec prisma migrate deploy >/dev/null
DATABASE_URL="file:$tmp/from-schema.db" pnpm exec prisma db push >/dev/null
python3 - "$tmp/from-migrations.db" "$tmp/from-schema.db" <<'PY'
import sqlite3, sys

def schema(filename):
    db = sqlite3.connect(filename)
    try:
        return sorted((kind, name, ''.join(sql.split()).lower()) for kind, name, sql in db.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' AND sql IS NOT NULL"))
    finally:
        db.close()

migrated, expected = map(schema, sys.argv[1:])
assert migrated == expected, f"baseline mismatch: {len(migrated)} objects from migrations, {len(expected)} from v1.68.0 schema"
PY
