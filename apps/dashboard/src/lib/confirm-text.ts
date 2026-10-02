// Typed confirmation of a destructive plan: the exact name, spaces around ignored.
export function confirmMatches(typed: string, expected: string): boolean {
  return expected !== '' && typed.trim() === expected
}

// The line a removal review opens with: what is lost.
export function removeNotice(name: string, used?: string): string {
  return used ? `The ${used} of data on ${name} will be erased.` : `The data on ${name} will be erased.`
}
