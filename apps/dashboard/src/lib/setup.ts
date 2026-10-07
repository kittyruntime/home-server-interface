// First-run setup assistant (#12): which screen to show. No Vue imports, so it
// is tested directly.

export type SetupScreen = 'token' | 'admin' | 'login' | 'identity' | 'next' | 'done'
export interface SetupStatus { required: boolean; step: string | null }

export function setupScreen(status: SetupStatus, loggedIn: boolean, hasSetupSession: boolean): SetupScreen {
  if (status.required) return hasSetupSession ? 'admin' : 'token'
  if (!status.step || status.step === 'done') return 'done'
  if (!loggedIn) return 'login'
  return status.step === 'next' ? 'next' : 'identity'
}

export function validHostname(name: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(name)
}
