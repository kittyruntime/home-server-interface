// Typed confirmation of a destructive plan: the exact name, spaces around ignored.
export function confirmMatches(typed: string, expected: string): boolean {
  return expected !== '' && typed.trim() === expected
}
