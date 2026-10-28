// "nyan", "Nyan" or "nyan.gif": the name before the extension is what counts.
export function isNyan(name: string): boolean {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return (dot > 0 ? lower.slice(0, dot) : lower) === 'nyan'
}
