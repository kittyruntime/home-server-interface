/** Return a stored pinned URL only when it is safe to use as a browser link. */
export function safePinnedUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' ? value : null
  } catch {
    return null
  }
}
