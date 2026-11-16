// Plain-language text for why Samba refused a connection.
const KNOWN = new Set(['wrong_password', 'unknown_user', 'account_disabled', 'no_access', 'blocked'])

export function reasonKey(reason: string): string {
  return `sharing.reason.${KNOWN.has(reason) ? reason : 'other'}`
}
