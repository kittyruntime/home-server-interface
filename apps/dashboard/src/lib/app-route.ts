// The open app in the URL (?app=storage), so a reload, a link or the browser's
// back button lands on the same app. Overview has no parameter.

type QueryValue = string | null | undefined | Array<string | null>

/** The app a query asks for, if this user has it; Overview otherwise. */
export function appFromQuery(value: QueryValue, allowed: string[]): string {
  const id = Array.isArray(value) ? value[0] : value
  return id && allowed.includes(id) ? id : 'dashboard'
}

/** The query for app `id`, keeping the other parameters. */
export function appQuery<T extends Record<string, unknown>>(query: T, id: string): Record<string, unknown> {
  const { app: _app, ...rest } = query
  return id === 'dashboard' ? rest : { ...rest, app: id }
}

/** Apps opened from elsewhere than the sidebar (the bell opens Activity). */
const UNLISTED_APPS = ['activity']

/** The apps a URL may open: this user's sidebar apps plus the unlisted ones. */
export function allowedAppIds(navIds: string[]): string[] {
  return [...navIds, ...UNLISTED_APPS.filter(id => !navIds.includes(id))]
}
