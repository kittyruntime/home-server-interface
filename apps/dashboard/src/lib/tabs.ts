// Keyboard model of a tab list (WAI-ARIA): arrows move and wrap, Home and End
// jump to the ends. Returns the tab to activate, or null for other keys.
export function nextTab(ids: string[], current: string, key: string): string | null {
  const i = ids.indexOf(current)
  if (i < 0 || !ids.length) return null
  switch (key) {
    case 'ArrowRight': return ids[(i + 1) % ids.length]!
    case 'ArrowLeft':  return ids[(i - 1 + ids.length) % ids.length]!
    case 'Home':       return ids[0]!
    case 'End':        return ids[ids.length - 1]!
    default:           return null
  }
}
