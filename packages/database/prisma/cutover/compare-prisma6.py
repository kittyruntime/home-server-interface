#!/usr/bin/env python3
"""Audit published SQLite fingerprints against an explicitly supplied Prisma 6 CLI.

Use HSI_PRISMA6_BIN=/path/to/prisma@6.19.3 for all states, then use a
prisma@6.9.0 binary with HSI_PRISMA6_OLD_ONLY=1 for the six oldest states.
"""
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
PRISMA6 = pathlib.Path(os.environ["HSI_PRISMA6_BIN"]).resolve()
INVENTORY = json.loads((pathlib.Path(__file__).parent / "states.json").read_text())


def git(*args):
    return subprocess.check_output(["/usr/bin/git", *args], cwd=ROOT)


def fingerprint(file):
    with sqlite3.connect(file) as db:
        rows = sorted((kind, name, re.sub(r"\s+", "", sql).lower()) for kind, name, sql in db.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' AND sql IS NOT NULL"))
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def main():
    mismatches = []
    with tempfile.TemporaryDirectory(prefix="hsi-prisma6-inventory-") as dirname:
        temp = pathlib.Path(dirname)
        for state in INVENTORY["states"]:
            tag = state["releases"][0]
            if os.environ.get("HSI_PRISMA6_OLD_ONLY") == "1" and INVENTORY["states"].index(state) < 14: continue
            folder = temp / state["sqliteSha256"][:16]
            folder.mkdir()
            db_file = folder / "state.db"
            paths = git("ls-tree", "-r", "--name-only", tag, "packages/database/prisma/schema").decode().splitlines()
            for p in paths:
                if not p.endswith(".prisma"): continue
                source = git("show", f"{tag}:{p}").decode()
                source = re.sub(r'^\s*url\s*=.*$', '  url = env("DATABASE_URL")', source, flags=re.MULTILINE)
                (folder / pathlib.Path(p).name).write_text(source)
            result = subprocess.run([str(PRISMA6), "db", "push", "--schema", str(folder), "--skip-generate"],
                cwd=ROOT / "packages/database", env={**os.environ, "DATABASE_URL": f"file:{db_file}"}, capture_output=True, text=True)
            if result.returncode: raise RuntimeError(f"{tag}: {result.stdout}\n{result.stderr}")
            actual = fingerprint(db_file)
            expected = state["sqliteSha256"]
            if actual != expected: mismatches.append((tag,expected,actual))
            print(f"{tag:10s} {'MATCH' if actual == expected else 'DIFF'} {actual[:12]}",flush=True)
    print(f"{len(INVENTORY['states'])} states compared, {len(mismatches)} mismatches")
    for row in mismatches: print(*row)
    if mismatches: raise SystemExit(1)


if __name__ == "__main__": main()
