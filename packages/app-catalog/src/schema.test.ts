import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The public catalog repository validates its apps with schema/, exported
// from the zod schema HSI reads: a change to one without the other fails here.
test("schema/app-manifest.schema.json is the export of the manifest format", () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "hsi-schema-")), "schema.json")
  const root = path.resolve(import.meta.dirname, "..")
  execFileSync("npx", ["tsx", "scripts/export-schema.ts", out], { cwd: root, stdio: "pipe" })
  assert.equal(readFileSync(out, "utf8"), readFileSync(path.join(root, "schema/app-manifest.schema.json"), "utf8"),
    "run `pnpm --filter @app/app-catalog schema` and copy schema/ to the catalog repository")
})

// The App Store draws logos as images, which need valid XML: an attribute
// repeated in a tag (tolerated when the logo was inserted as markup) leaves
// an empty box.
test("no bundled icon repeats an attribute in a tag", async () => {
  const { ICONS } = await import("./icons")
  for (const [id, svg] of Object.entries(ICONS)) {
    for (const [tag] of svg.matchAll(/<[A-Za-z][^>]*>/g)) {
      const names = [...tag.matchAll(/[\s/]([A-Za-z_:][\w:.-]*)\s*=/g)].map(m => m[1])
      assert.equal(new Set(names).size, names.length, `${id}: ${tag.slice(0, 80)}`)
    }
  }
})
