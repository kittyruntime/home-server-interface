// Plain-language text for why Samba refused a connection.
const KNOWN = new Set(['wrong_password', 'unknown_user', 'account_disabled', 'no_access', 'blocked'])

export function reasonKey(reason: string): string {
  return `sharing.reason.${KNOWN.has(reason) ? reason : 'other'}`
}

/** The sentence for one journal line (params: share). */
export function eventKey(e: { kind: string; result: string }): string {
  if (e.result === 'ok') {
    if (e.kind === 'auth') return 'sharing.event.signedIn'
    return e.kind === 'disconnect' ? 'sharing.event.disconnected' : 'sharing.event.connected'
  }
  return e.kind === 'auth' ? 'sharing.event.refusedSignIn' : 'sharing.event.refusedShare'
}
