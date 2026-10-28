#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
for release in v1.6.1 v1.11.3; do
  db="$tmp/$release.db"
  python3 - "$root/scripts/tests/fixtures/database/$release.sql" "$db" <<'PY'
import sqlite3,sys
from pathlib import Path
with sqlite3.connect(sys.argv[2]) as conn:
    conn.executescript(Path(sys.argv[1]).read_text())
    now='2026-10-01T00:00:00Z'
    conn.execute('INSERT INTO "Place" ("id","name","path","createdAt","updatedAt") VALUES (?,?,?,?,?)', ('place-1','Media','/srv/media',now,now))
    conn.execute('INSERT INTO "ContainerApp" ("id","name","image","volumes","updatedAt") VALUES (?,?,?,?,?)',
                 ('app-1','sample-app','nginx:stable','[{"type":"place","source":"place-1","target":"/media","readOnly":true}]',now))
PY
  cp "$db" "$tmp/$release-original.db"
  cd "$root/packages/database"
  export DATABASE_URL="file:$db" HSI_CONTAINERS_DIR="$tmp/live-$release" HSI_CONTAINERS_STAGE="$tmp/staged-$release"
  mkdir -p "$HSI_CONTAINERS_DIR"
  inspection=$(node --import tsx prisma/cutover/cli.ts inspect "$db")
  read -r kind source permissions compose representative <<< "$inspection"
  test "$kind" = historical
  test "$representative" = "$release"
  test "$permissions" = 1
  test "$compose" = 1
  node --import tsx prisma/cutover/compose-staging.ts
  grep -q '/srv/media:/media:ro' "$HSI_CONTAINERS_STAGE/sample-app/compose.yaml"
  node --import tsx prisma/cutover/permissions-redesign.ts
  node --import tsx prisma/cutover/cli.ts convert "$db" "$source"
  pnpm exec prisma migrate resolve --applied 0_baseline_v1680 >/dev/null
  pnpm exec prisma migrate deploy >/dev/null
  test "$(node --import tsx prisma/cutover/cli.ts verify "$db")" = migrated
  node --import tsx prisma/cutover/compose-apply.ts
  test -f "$HSI_CONTAINERS_DIR/sample-app/compose.yaml"
  python3 - "$db" "$root/packages/database/prisma/schema/migrations" <<'PY'
import sqlite3,sys
from pathlib import Path
shipped = sorted(p.name for p in Path(sys.argv[2]).iterdir() if p.is_dir())
with sqlite3.connect(sys.argv[1]) as conn:
    applied = [row[0] for row in conn.execute('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name')]
assert applied == shipped, applied
PY
  cp "$tmp/$release-original.db" "$db"
  node --import tsx prisma/cutover/compose-restore-source.ts
  test ! -e "$HSI_CONTAINERS_DIR/sample-app/compose.yaml"
  test "$(node --import tsx prisma/cutover/cli.ts inspect "$db" | cut -d' ' -f1)" = historical
  node --import tsx prisma/cutover/compose-staging.ts
  node --import tsx prisma/cutover/permissions-redesign.ts >/dev/null
  node --import tsx prisma/cutover/cli.ts convert "$db" "$source" >/dev/null
  pnpm exec prisma migrate resolve --applied 0_baseline_v1680 >/dev/null
  pnpm exec prisma migrate deploy >/dev/null
  test "$(node --import tsx prisma/cutover/cli.ts verify "$db")" = migrated
  echo "old ContainerApp cutover, restore and retry: $release"
done
