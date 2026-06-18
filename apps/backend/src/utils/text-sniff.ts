// Cheap, dependency-free binary-vs-text heuristic, applied before a file's
// content is ever sent to the frontend's code editor. Mirrors the approach
// git itself uses (NUL byte in a sample => binary), plus a fallback ratio
// check on UTF-8 replacement characters for binary data that happens not to
// contain a NUL byte in the sampled window.
const SAMPLE_SIZE = 8192
const REPLACEMENT_CHAR_RATIO_THRESHOLD = 0.01

export function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false
  const sample = buf.subarray(0, Math.min(buf.length, SAMPLE_SIZE))
  if (sample.includes(0)) return true

  const text = sample.toString("utf-8")
  let replacementCount = 0
  for (const ch of text) if (ch === "�") replacementCount++
  return replacementCount / text.length > REPLACEMENT_CHAR_RATIO_THRESHOLD
}
