// App Store install helpers (#26). No Vue imports, so they are tested directly.

/** A strong random value for a secret setting: 32 bytes, base64url. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Host ports to try after `from` when it is taken: the next ones up, skipping
 * those the form already gives to other ports, at most `count`.
 */
export function portCandidates(from: number, taken: Set<number>, count: number): number[] {
  const out: number[] = []
  for (let p = from + 1; p <= 65535 && out.length < count; p++) {
    if (!taken.has(p)) out.push(p)
  }
  return out
}
