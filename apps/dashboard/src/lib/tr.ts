// Translation hook for plain modules (shared with tests run outside the
// browser): they say tr(key, englishText, params) and stay English until the
// app connects them to vue-i18n (i18n/labels.ts).
export type Params = Record<string, unknown>

let translate: (key: string, english: string, params?: Params) => string = (_key, english) => english

export function tr(key: string, english: string, params?: Params): string {
  return translate(key, english, params)
}

export function setTranslator(fn: (key: string, english: string, params?: Params) => string) {
  translate = fn
}
