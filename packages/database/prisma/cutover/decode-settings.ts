export function decodeSetting<T>(s: unknown, fallback: T[], appName: string, field: string, itemKind: "object" | "string", onSkip?: (reason: string) => void): T[] {
  if (s == null) return fallback
  let value: unknown
  try { value = JSON.parse(String(s)) } catch {
    const reason = `invalid ${field} settings were skipped`
    console.warn(`warning: application "${appName}": ${reason}`)
    onSkip?.('the saved value could not be read')
    return fallback
  }
  if (!Array.isArray(value) || !value.every(item => itemKind === "string"
    ? typeof item === "string"
    : item !== null && typeof item === "object" && !Array.isArray(item))) {
    throw new Error(`application "${appName}": ${field} must be a list of ${itemKind === "string" ? "strings" : "objects"}`)
  }
  return value as T[]
}
