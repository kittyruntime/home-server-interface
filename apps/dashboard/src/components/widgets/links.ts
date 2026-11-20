// The links widget stores { label, url } pairs; only http(s) addresses are kept.
export type WidgetLink = { label: string; url: string }

export function parseLinks(raw: unknown): WidgetLink[] {
  if (!Array.isArray(raw)) return []
  const out: WidgetLink[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const url = String((item as { url?: unknown }).url ?? '').trim()
    if (!/^https?:\/\/[^\s]+$/i.test(url)) continue
    const label = String((item as { label?: unknown }).label ?? '').trim() || url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    out.push({ label: label.slice(0, 60), url: url.slice(0, 2048) })
    if (out.length >= 24) break
  }
  return out
}
