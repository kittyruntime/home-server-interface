// Writes the JSON Schema of an app manifest (#26), from the zod schema HSI
// itself reads, for the public catalog repository to validate its apps with.
//   pnpm --filter @app/app-catalog schema
import { writeFileSync } from "node:fs"
import { z } from "zod"
import { zAppManifest } from "../src/manifest"
import { CATALOG_INDEX_SCHEMA } from "../src/remote"

const manifest = z.toJSONSchema(zAppManifest, { io: "input", unrepresentable: "any" }) as Record<string, unknown>

// zod writes startsWith as a "starts_with" format beside the pattern that
// already says it; no JSON Schema validator knows that format.
function dropStartsWith(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(dropStartsWith)
  if (!node || typeof node !== "object") return
  const o = node as Record<string, unknown>
  if (o.format === "starts_with" && typeof o.pattern === "string") delete o.format
  Object.values(o).forEach(dropStartsWith)
}
dropStartsWith(manifest)
const props = (manifest.properties ?? {}) as Record<string, unknown>
// Fields of a catalog entry beside the manifest itself.
props.icon = { type: "string", description: "SVG logo, inline" }
props.minHsiVersion = { type: "string", pattern: "^v?\\d+\\.\\d+\\.\\d+$", description: "Oldest HSI that can install this app" }
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://github.com/kittyruntime/home-server-interface-apps/schema/app-manifest.v${CATALOG_INDEX_SCHEMA}.json`,
  title: "HSI App Store manifest",
  ...manifest,
  properties: props,
}
writeFileSync(process.argv[2] ?? "schema/app-manifest.schema.json", JSON.stringify(schema, null, 2) + "\n")
