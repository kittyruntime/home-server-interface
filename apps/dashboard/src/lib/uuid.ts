// crypto.randomUUID() is only exposed in secure contexts (HTTPS, or
// http://localhost) — accessing this dashboard over a plain-HTTP LAN IP
// (the common case for a self-hosted NAS) makes it undefined, while
// crypto.getRandomValues() stays available everywhere. Fall back to
// building a UUID-shaped string from it rather than throwing.
export function randomId(): string {
  return crypto.randomUUID?.() ?? Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    b => b.toString(16).padStart(2, '0'),
  ).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
}
