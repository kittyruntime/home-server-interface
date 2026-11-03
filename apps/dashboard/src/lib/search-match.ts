/* Lowercase and strip accents, so "theo" finds "Theophile" written with one. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const q = foldText(query.trim())
  if (!q) return true
  return foldText(fields.filter(Boolean).join(' ')).includes(q)
}
