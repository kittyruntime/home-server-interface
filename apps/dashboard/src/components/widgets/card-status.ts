import { inject, provide, reactive, watchEffect, type InjectionKey } from 'vue'
import type { Source } from '../../lib/widget-data'

// What a widget tells its card: when its data was read and whether reading
// failed, for the card's footer.

export type CardStatus = { at: number; stale: boolean; error: string | null }
const KEY: InjectionKey<CardStatus> = Symbol('widget-card-status')

export function provideCardStatus(): CardStatus {
  const status = reactive<CardStatus>({ at: 0, stale: false, error: null })
  provide(KEY, status)
  return status
}

/** Reports one or more sources to the card: the oldest read and the first error. */
export function reportSources(...sources: Array<Source<unknown>>): void {
  const status = inject(KEY, null)
  if (!status) return
  watchEffect(() => {
    status.at = Math.min(...sources.map(s => s.at.value || Date.now()))
    status.stale = sources.some(s => s.stale.value)
    status.error = sources.map(s => s.error.value).find(e => e) ?? null
  })
}
