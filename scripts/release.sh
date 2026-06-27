#!/usr/bin/env bash
# Usage: scripts/release.sh <version>
# Example: scripts/release.sh 1.10.0
#
# Bumps package.json, updates CHANGELOG.md, commits, tags, and pushes —
# which triggers the release workflow on GitHub Actions.
set -euo pipefail

REPO="kittyruntime/home-server-interface"

# ── Args ──────────────────────────────────────────────────────────────────────

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>  (e.g. $0 1.10.0)" >&2
  exit 1
fi
VERSION="${VERSION#v}"   # strip leading 'v' if supplied
TAG="v$VERSION"
DATE=$(date +%Y-%m-%d)

# ── Pre-flight ─────────────────────────────────────────────────────────────────

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty — commit or stash changes first." >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Must be on 'main' (currently on '$BRANCH')." >&2
  exit 1
fi

if git rev-parse "$TAG" &>/dev/null; then
  echo "Tag $TAG already exists." >&2
  exit 1
fi

# ── Validate [Unreleased] has content ─────────────────────────────────────────

UNRELEASED=$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md | sed '/^[[:space:]]*$/d')
if [[ -z "$UNRELEASED" ]]; then
  echo "[Unreleased] section in CHANGELOG.md is empty — add your changes before releasing." >&2
  exit 1
fi

# ── Update package.json ────────────────────────────────────────────────────────

python3 - "$VERSION" <<'PY'
import sys, json, pathlib
v = sys.argv[1]
p = pathlib.Path("package.json")
data = json.loads(p.read_text())
data["version"] = v
p.write_text(json.dumps(data, indent=2) + "\n")
PY

# ── Update CHANGELOG.md ────────────────────────────────────────────────────────

python3 - "$VERSION" "$DATE" "$REPO" "$TAG" <<'PY'
import sys, re, pathlib

version, date, repo, tag = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

p = pathlib.Path("CHANGELOG.md")
text = p.read_text()

# Extract previous tag from the existing [Unreleased] link
m = re.search(
    r'\[Unreleased\]: https://github\.com/[^/]+/[^/]+/compare/(v[\d.]+)\.\.\.HEAD',
    text,
)
if m:
    prev_tag = m.group(1)
    new_version_link = f"[{version}]: https://github.com/{repo}/compare/{prev_tag}...{tag}"
else:
    new_version_link = f"[{version}]: https://github.com/{repo}/releases/tag/{tag}"

# 1. Rename ## [Unreleased] → ## [VERSION] - DATE, insert fresh ## [Unreleased] above
text = text.replace(
    "## [Unreleased]",
    f"## [Unreleased]\n\n## [{version}] - {date}",
    1,
)

# 2. Update the [Unreleased] comparison link
text = re.sub(
    r'\[Unreleased\]: https://github\.com/\S+/compare/\S+\.\.\.HEAD',
    f'[Unreleased]: https://github.com/{repo}/compare/{tag}...HEAD',
    text,
)

# 3. Insert the new version link right after [Unreleased] link
text = re.sub(
    r'(\[Unreleased\]: [^\n]+\n)',
    lambda mo: mo.group(0) + new_version_link + "\n",
    text,
    count=1,
)

p.write_text(text)
print(f"CHANGELOG.md updated for {tag}")
PY

# ── Commit, tag, push ──────────────────────────────────────────────────────────

git add package.json CHANGELOG.md
git commit -m "chore: bump version to $TAG"
git tag -a "$TAG" -m "Release $TAG"

git push origin main
git push origin "$TAG"

echo ""
echo "✓ $TAG pushed — release workflow running at:"
echo "  https://github.com/$REPO/actions"
