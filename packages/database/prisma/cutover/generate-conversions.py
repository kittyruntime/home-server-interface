#!/usr/bin/env python3
"""Generate review candidates only; copied SQL becomes immutable after review."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import tempfile
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
PKG = ROOT / "packages/database"
HERE = pathlib.Path(__file__).parent
INVENTORY = json.loads((HERE / "states.json").read_text())
BASELINE = INVENTORY["states"][0]["sqliteSha256"]


def run(*args, env=None):
    p = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True)
    if p.returncode: raise RuntimeError(f"{args}: {p.stdout}\n{p.stderr}")
    return p.stdout


def git(*args):
    return subprocess.check_output(["/usr/bin/git", *args], cwd=ROOT)


def canonical(db_file):
    with sqlite3.connect(db_file) as db:
        return sorted((kind, name, re.sub(r"\s+", "", sql).lower()) for kind, name, sql in db.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' AND sql IS NOT NULL"))


def fingerprint(db_file):
    return hashlib.sha256(json.dumps(canonical(db_file), separators=(",", ":")).encode()).hexdigest()


def seed_representative_rows(db_file):
    with sqlite3.connect(db_file) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        def add(table, values):
            if table not in tables: return
            cols = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
            values = {key: value for key, value in values.items() if key in cols}
            fields = ",".join(f'"{key}"' for key in values)
            marks = ",".join("?" for _ in values)
            db.execute(f'INSERT INTO "{table}" ({fields}) VALUES ({marks})', list(values.values()))
        now = "2026-10-01T00:00:00.000Z"
        add("Place", {"id": "place-1", "name": "Documents", "path": "/srv/documents", "createdAt": now, "updatedAt": now})
        add("User", {"id": "admin-1", "username": "alice", "password": "$2hash", "createdAt": now, "updatedAt": now, "isAdmin": 1, "isUserManager": 1})
        add("User", {"id": "bob-1", "username": "bob", "password": "$2hash", "createdAt": now, "updatedAt": now})
        add("UserPlacePermission", {"id": "direct-1", "userId": "bob-1", "placeId": "place-1", "canRead": 0, "canWrite": 1, "canDelete": 0, "canShare": 0})
        if "Role" in tables:
            add("Role", {"id": "admin-role", "name": "admin", "isAdmin": 1, "createdAt": now})
            add("Role", {"id": "bob-role", "name": "bob", "isAdmin": 0, "createdAt": now})
            add("UserRole", {"userId": "admin-1", "roleId": "admin-role"})
            add("UserRole", {"userId": "bob-1", "roleId": "bob-role"})
            add("RolePlacePermission", {"id": "group-perm", "roleId": "bob-role", "placeId": "place-1", "canRead": 1, "canWrite": 0, "canDelete": 0, "canShare": 0})
            add("Permission", {"id": "manage-users", "name": "users.manage"})
            add("RolePermission", {"roleId": "admin-role", "permissionId": "manage-users"})
        elif "Group" in tables:
            add("Group", {"id": "bob-group", "name": "friends", "createdAt": now})
            add("UserGroup", {"userId": "bob-1", "groupId": "bob-group"})
            add("GroupPlacePermission", {"id": "group-perm", "groupId": "bob-group", "placeId": "place-1", "canRead": 1, "canWrite": 0, "canDelete": 0, "canShare": 0})
        add("ContainerApp", {"id": "app-1", "name": "sample-app", "image": "nginx:stable", "createdAt": now, "updatedAt": now})


def verify_representative_rows(db_file, had_roles):
    with sqlite3.connect(db_file) as db:
        users = dict(db.execute('SELECT "id", "username" FROM "User"'))
        assert users == {"admin-1": "alice", "bob-1": "bob"}, users
        assert db.execute('SELECT "path" FROM "Place" WHERE "id"=?', ("place-1",)).fetchone()[0] == "/srv/documents"
        flags = db.execute('SELECT "canRead", "canWrite" FROM "UserPlacePermission" WHERE "userId"=?', ("bob-1",)).fetchone()
        assert flags == ((1, 1) if had_roles else (0, 1)), flags
        if had_roles:
            assert db.execute('SELECT "isAdmin", "isUserManager" FROM "User" WHERE "id"=?', ("admin-1",)).fetchone() == (1, 1)


def write_schema(tag, schema_dir):
    schema_dir.mkdir(parents=True)
    paths = git("ls-tree", "-r", "--name-only", tag, "packages/database/prisma/schema").decode().splitlines()
    for p in paths:
        if not p.endswith(".prisma"): continue
        text = git("show", f"{tag}:{p}").decode()
        (schema_dir / pathlib.Path(p).name).write_text(re.sub(r"^\s*url\s*=.*\n", "", text, flags=re.MULTILINE))


def main():
    conversions = []
    with tempfile.TemporaryDirectory(prefix="hsi-cutover-conversions-") as dirname:
        temp = pathlib.Path(dirname)
        # Conversions lead to the v1.68.0 baseline; later migrations run after them.
        baseline_schema = temp / "baseline-schema"
        write_schema(INVENTORY["states"][0]["releases"][0], baseline_schema)
        for state in INVENTORY["states"]:
            if len(sys.argv) > 1 and sys.argv[1] not in state["releases"]: continue
            source_hash = state["sqliteSha256"]
            if source_hash == BASELINE: continue
            tag = state["releases"][0]
            state_dir = temp / source_hash
            schema_dir = state_dir / "schema"
            write_schema(tag, schema_dir)
            db_file = state_dir / "state.db"
            env = {**os.environ, "DATABASE_URL": f"file:{db_file}"}
            run("pnpm", "--filter", "@app/database", "exec", "prisma", "db", "push", "--schema", str(schema_dir), env=env)
            assert fingerprint(db_file) == source_hash, tag
            seed_representative_rows(db_file)
            with sqlite3.connect(db_file) as db:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            needs_permissions = "Role" in tables
            needs_compose = "ContainerApp" in tables
            if needs_permissions:
                with sqlite3.connect(db_file) as db:
                    for table in ("RolePlacePermission", "UserPlacePermission"):
                        columns = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
                        if "canShare" not in columns:
                            db.execute(f'ALTER TABLE "{table}" ADD COLUMN "canShare" BOOLEAN NOT NULL DEFAULT 0')
                run("pnpm", "--dir", str(PKG), "exec", "node", "--import", "tsx", "prisma/cutover/permissions-redesign.ts", env=env)
            sql = run("pnpm", "--filter", "@app/database", "exec", "prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", str(baseline_schema), "--script", env=env).rstrip() + "\n"
            dest = HERE / "conversions" / source_hash[:16]
            dest.mkdir(parents=True, exist_ok=True)
            (dest / "migration.sql").write_text(sql)
            test_file = state_dir / "converted.db"
            shutil.copyfile(db_file, test_file)
            with sqlite3.connect(test_file) as db:
                db.executescript(sql)
                integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
                foreign_key_errors = db.execute("PRAGMA foreign_key_check").fetchall()
            if integrity != "ok" or foreign_key_errors:
                raise RuntimeError(f"{tag}: integrity={integrity}, foreign_keys={foreign_key_errors}")
            actual = fingerprint(test_file)
            verify_representative_rows(test_file, needs_permissions)
            if actual != BASELINE:
                baseline_file = temp / "expected.db"
                run("pnpm", "--filter", "@app/database", "exec", "prisma", "db", "push", "--schema", str(baseline_schema), env={**os.environ, "DATABASE_URL": f"file:{baseline_file}"})
                got = {(kind, name): sql for kind, name, sql in canonical(test_file)}
                want = {(kind, name): sql for kind, name, sql in canonical(baseline_file)}
                for key in sorted(set(got) | set(want)):
                    if got.get(key) != want.get(key): print("DIFF", key, "got=", got.get(key), "want=", want.get(key), flush=True)
                raise RuntimeError(f"{tag}: converted fingerprint {actual} != baseline {BASELINE}")
            conversions.append({"source": source_hash, "representativeRelease": tag,
                                "needsPermissions": needs_permissions, "needsCompose": needs_compose,
                                "sql": str((dest / "migration.sql").relative_to(HERE)),
                                "sqlSha256": hashlib.sha256(sql.encode()).hexdigest()})
            print(f"{tag:10s} {source_hash[:12]} {len(sql.splitlines()):4d} lines, permissions={needs_permissions}, compose={needs_compose}", flush=True)
    (HERE / "conversions.json").write_text(json.dumps(conversions, indent=2) + "\n")


if __name__ == "__main__":
    main()
