export function reportCutoverError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`error: ${message.replace(/\s+/g, " ").slice(0, 400)}`)
  process.exitCode = 1
}
