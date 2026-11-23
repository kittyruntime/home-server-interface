// Rewrites a bundle so it is pure ASCII. Node keeps a module's source in
// memory as a string, and V8 stores a string with any character outside
// Latin-1 at two bytes per character: one stray character doubles the
// backend's largest string. esbuild's --charset=ascii escapes strings and
// identifiers but leaves regular expression literals alone, so this escapes
// what is left. \uXXXX means the same character in strings, templates and
// regular expressions (a surrogate pair too, with the u flag).
import { readFileSync, writeFileSync } from "node:fs"

const file = process.argv[2]
if (!file) throw new Error("usage: ascii-bundle.mjs <file>")
const src = readFileSync(file, "utf8")
const out = src.replace(/[\u0080-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
if (out !== src) writeFileSync(file, out)
