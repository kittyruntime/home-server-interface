#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
python3 - "$root/scripts/tests/fixtures/database/v1.52.0.sql" "$tmp/old.db" <<'PY'
import sqlite3,sys
from pathlib import Path
with sqlite3.connect(sys.argv[2]) as db:
    db.executescript(Path(sys.argv[1]).read_text())
    now='2026-10-01T00:00:00Z'
    db.execute('INSERT INTO "Place" ("id","name","path","createdAt","updatedAt") VALUES (?,?,?,?,?)', ('place-1','Media','/srv/media',now,now))
    db.execute('INSERT INTO "ContainerApp" ("id","name","image","volumes","updatedAt") VALUES (?,?,?,?,?)',
               ('app-1','sample-app','nginx:stable','[{"type":"named","source":"photos","target":"/photos","readOnly":false},{"type":"place","source":"place-1","target":"/media","readOnly":true}]',now))
PY
mkdir -p "$tmp/live"
(cd "$root/packages/database" && DATABASE_URL="file:$tmp/old.db" HSI_CONTAINERS_DIR="$tmp/live" HSI_CONTAINERS_STAGE="$tmp/staged" node --import tsx prisma/cutover/compose-staging.ts)
python3 - "$tmp" <<'PY'
import json,sqlite3,sys
from pathlib import Path
root=Path(sys.argv[1]); manifest=json.loads((root/'staged/manifest.json').read_text())
assert manifest['entries']==[{'name':'sample-app','operation':'create','originalSha256':None,'stagedSha256':manifest['entries'][0]['stagedSha256']}]
yaml=(root/'staged/sample-app/compose.yaml').read_text()
assert 'photos:' in yaml and 'name: photos' in yaml and '/srv/media:/media:ro' in yaml, yaml
assert not (root/'live/sample-app/compose.yaml').exists()
with sqlite3.connect(root/'old.db') as db:
    assert db.execute('SELECT COUNT(*) FROM "ContainerApp"').fetchone()[0]==1
PY
(cd "$root/packages/database" && DATABASE_URL="file:$tmp/old.db" HSI_CONTAINERS_DIR="$tmp/live" HSI_CONTAINERS_STAGE="$tmp/staged" node --import tsx prisma/cutover/compose-apply.ts)
python3 - "$tmp" <<'PY'
import sys
from pathlib import Path
root=Path(sys.argv[1])
assert (root/'live/sample-app/compose.yaml').read_text() == (root/'staged/sample-app/compose.yaml').read_text()
PY
(cd "$root/packages/database" && DATABASE_URL="file:$tmp/old.db" HSI_CONTAINERS_DIR="$tmp/live" HSI_CONTAINERS_STAGE="$tmp/staged" node --import tsx prisma/cutover/compose-restore-source.ts)
test ! -e "$tmp/live/sample-app/compose.yaml"
