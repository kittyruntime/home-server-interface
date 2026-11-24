/** A failed two-step create can still have durably written the app definition. */
export function isSavedBeforeStartFailure(result: { results: Array<{ status: string }> }): boolean {
  return result.results.length > 1 && result.results[0]?.status === 'done'
}
