export function decodeSetting<T>(s: unknown, fallback: T[], appName: string, field: string, itemKind: "object" | "string"): T[] {
  if (s == null) return fallback
  let value: unknown
  try { value = JSON.parse(String(s)) } catch {
    console.warn(`warning: application "${appName}": invalid ${field} settings were skipped`)
    return fallback
  }
  if (!Array.isArray(value) || !value.every(item => itemKind === "string"
    ? typeof item === "string"
    : item !== null && typeof item === "object" && !Array.isArray(item))) {
    throw new Error(`application "${appName}": ${field} must be a list of ${itemKind === "string" ? "strings" : "objects"}`)
  }
  return value as T[]
}
