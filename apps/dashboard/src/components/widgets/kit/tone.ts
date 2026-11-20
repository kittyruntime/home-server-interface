export type Tone = 'ok' | 'warn' | 'bad' | 'neutral'

/** Level of a percentage that fills up: warning from `warn`, bad from `bad`. */
export function toneOf(pct: number, warn = 75, bad = 90): Tone {
  if (pct >= bad) return 'bad'
  if (pct >= warn) return 'warn'
  return 'ok'
}

export const TEXT: Record<Tone, string> = { ok: 'text-success', warn: 'text-warning', bad: 'text-error', neutral: 'text-base-content/60' }
export const DOT: Record<Tone, string> = { ok: 'bg-success', warn: 'bg-warning', bad: 'bg-error', neutral: 'bg-base-content/40' }

/** Rows a widget shows at each size. */
export const ROWS = { s: 3, m: 5, l: 12 } as const
