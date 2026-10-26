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
printf 'not sqlite\n' > "$tmp/corrupt.db"
if DATABASE_URL="file:$tmp/corrupt.db" node --import tsx prisma/cutover/cli.ts inspect "$tmp/corrupt.db" >"$tmp/output" 2>&1; then
  echo 'corrupt database was accepted' >&2; exit 1
fi
grep -q '^error: SQLite database file is corrupt or is not a database$' "$tmp/output"
! grep -q ' at .*\.ts:' "$tmp/output"
touch "$tmp/empty.db"
if DATABASE_URL="file:$tmp/empty.db" node --import tsx prisma/cutover/cli.ts inspect "$tmp/empty.db" >"$tmp/output" 2>&1; then
  echo 'empty database was accepted' >&2; exit 1
fi
grep -q '^error: SQLite database file is empty or incomplete$' "$tmp/output"
