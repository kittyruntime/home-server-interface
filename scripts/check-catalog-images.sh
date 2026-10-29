#!/usr/bin/env bash
# Checks that every image the App Store pins (apps and their services) still
# exists upstream and is published for linux/amd64, the platform HSI ships
# for. Needs Docker; reads the registries anonymously.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

images=$(node -e '
  const fs = require("fs"), dir = process.argv[1]
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    const m = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(m.id + " " + m.image)
    for (const s of m.services ?? []) console.log(m.id + "/" + s.name + " " + s.image)
  }' "$root/packages/app-catalog/apps")

failed=0
while read -r who image; do
  if ! raw=$(docker buildx imagetools inspect --raw "$image" 2>&1); then
    echo "FAIL $who: $image cannot be read: $(tail -1 <<<"$raw")"; failed=1; continue
  fi
  # A multi-platform index lists its platforms; a single manifest is checked
  # through its config.
  if grep -q '"manifests"' <<<"$raw"; then
    platforms=$(node -e 'const m=JSON.parse(process.argv[1]); console.log(m.manifests.map(x => x.platform && x.platform.os + "/" + x.platform.architecture).filter(Boolean).join(" "))' "$raw")
  else
    platforms=$(docker buildx imagetools inspect --format '{{json .Image}}' "$image" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);console.log(i.os+"/"+i.architecture)})')
  fi
  if [[ " $platforms " != *" linux/amd64 "* ]]; then
    echo "FAIL $who: $image has no linux/amd64 image ($platforms)"; failed=1; continue
  fi
  echo "ok   $who: $image"
done <<<"$images"
exit "$failed"
