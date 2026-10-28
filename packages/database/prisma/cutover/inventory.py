#!/usr/bin/env python3
"""Rebuild the SQLite schema of every published HSI tag for the cutover review.

Uses Prisma 7 `db push` only on temporary databases. Never runs on an installed DB.
The checked-in output is verified in CI; populated release fixtures remain a release gate.
"""
import hashlib
import json
import pathlib
import re
import sqlite3
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
TAGS = json.loads((pathlib.Path(__file__).parent / "published-releases.json").read_text())
SCHEMA_PREFIX = "packages/database/prisma/schema/"
DATA_PREFIX = "packages/database/prisma/data-migrations/"


def git(*args):
    return subprocess.check_output(["/usr/bin/git", *args], cwd=ROOT)


# Constraint and index names left on the renamed tables by the v1.35.0 Role -> Group
# rename, read as the current ones; must match packages/database/src/cutover/preflight.ts.
LEGACY_NAMES = {
    "RolePlacePermission_roleId_fkey": "GroupPlacePermission_groupId_fkey",
    "RolePlacePermission_placeId_fkey": "GroupPlacePermission_placeId_fkey",
    "RolePlacePermission_roleId_placeId_key": "GroupPlacePermission_groupId_placeId_key",
    "UserRole_userId_fkey": "UserGroup_userId_fkey",
    "UserRole_roleId_fkey": "UserGroup_groupId_fkey",
    "Role_name_key": "Group_name_key",
}
LEGACY_SQL_NAMES = {legacy.lower(): current.lower() for legacy, current in LEGACY_NAMES.items()}
RENAMED_TABLES = {"Group", "GroupPlacePermission", "UserGroup"}


def canonical_entry(kind, name, table, sql):
    sql = re.sub(r"\s+", "", sql).lower()
    if table not in RENAMED_TABLES:
        return (kind, name, sql)
    sql = re.sub(r'"([a-z_]+)"', lambda m: f'"{LEGACY_SQL_NAMES.get(m.group(1), m.group(1))}"', sql)
    return (kind, LEGACY_NAMES.get(name, name), sql)


def canonical_schema(db_file):
    with sqlite3.connect(db_file) as db:
        rows = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' AND sql IS NOT NULL").fetchall()
    return sorted(canonical_entry(*row) for row in rows)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def main():
    candidates = {}
    releases = {}
    for tag in TAGS:
        paths = git("ls-tree", "-r", "--name-only", tag, "packages/database/prisma").decode().splitlines()
        schemas = sorted(p for p in paths if p.startswith(SCHEMA_PREFIX) and p.endswith(".prisma"))
        scripts = sorted(p for p in paths if p.startswith(DATA_PREFIX) and p.endswith(".ts"))
        source = b"".join(p.encode() + b"\0" + git("show", f"{tag}:{p}") + b"\0" for p in schemas)
        source_hash = digest(source)
        data = [{"file": pathlib.Path(p).name, "sha256": digest(git("show", f"{tag}:{p}"))} for p in scripts]
        releases[tag] = {"schemaSourceSha256": source_hash, "dataScripts": data}
        candidates.setdefault(source_hash, {"tag": tag, "files": schemas})
    with tempfile.TemporaryDirectory(prefix="hsi-cutover-inventory-") as work:
        temp = pathlib.Path(work)
        for source_hash, candidate in candidates.items():
            schema_dir = temp / source_hash / "schema"
            schema_dir.mkdir(parents=True)
            for p in candidate["files"]:
                text = git("show", f"{candidate['tag']}:{p}").decode()
                text = re.sub(r"^\s*url\s*=.*\n", "", text, flags=re.MULTILINE)
                (schema_dir / pathlib.Path(p).name).write_text(text)
            db_file = temp / source_hash / "state.db"
            result = subprocess.run(
                ["pnpm", "--filter", "@app/database", "exec", "prisma", "db", "push", "--schema", str(schema_dir)],
                cwd=ROOT, env={**__import__("os").environ, "DATABASE_URL": f"file:{db_file}"},
                text=True, capture_output=True,
            )
            if result.returncode:
                raise RuntimeError(f"{candidate['tag']}: {result.stderr}\n{result.stdout}")
            rows = canonical_schema(db_file)
            candidate["sqliteSha256"] = digest(json.dumps(rows, separators=(",", ":")).encode())
            candidate["objectCount"] = len(rows)
    states = {}
    for tag, info in releases.items():
        candidate = candidates[info["schemaSourceSha256"]]
        state_id = candidate["sqliteSha256"]
        states.setdefault(state_id, {"sqliteSha256": state_id, "objectCount": candidate["objectCount"], "releases": [], "dataScriptVariants": []})
        state = states[state_id]
        state["releases"].append(tag)
        if info["dataScripts"] not in state["dataScriptVariants"]:
            state["dataScriptVariants"].append(info["dataScripts"])
    output = {"note": "Generated from each published tag's schema using Prisma 7 on empty temporary SQLite databases; validate on populated release fixtures before release.", "releases": releases, "states": list(states.values())}
    (pathlib.Path(__file__).parent / "states.json").write_text(json.dumps(output, indent=2) + "\n")
    print(f"{len(releases)} published releases, {len(candidates)} schema source variants, {len(states)} SQLite schema states")


if __name__ == "__main__":
    main()
