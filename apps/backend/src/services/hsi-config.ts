import { readFile } from "node:fs/promises"
import { parse } from "smol-toml"
import { log } from "../utils/log"

// Server settings an administrator edits by hand, in HSI's configuration
// folder next to nats.conf and worker.env (kept across updates). A missing
// file or key means the default; an invalid value is ignored, with a warning.
export const HSI_CONFIG_FILE = process.env.HSI_CONFIG_FILE ?? "/etc/hsi/hsi.toml"

export interface HsiConfig {
  audit: {
    /** Days the audit log keeps an entry; 0 keeps them forever. */
    retentionDays: number
  }
}

export const DEFAULT_HSI_CONFIG: HsiConfig = {
  audit: { retentionDays: 365 },
}

export function parseHsiConfig(text: string): { config: HsiConfig; warnings: string[] } {
  const config: HsiConfig = structuredClone(DEFAULT_HSI_CONFIG)
  const warnings: string[] = []
  let doc: Record<string, unknown>
  try {
    doc = parse(text)
  } catch (e) {
    return { config, warnings: [`not valid TOML (${(e as Error).message}): defaults used`] }
  }
  const audit = doc.audit
  if (audit !== undefined) {
    if (typeof audit !== "object" || audit === null || Array.isArray(audit)) {
      warnings.push("[audit] must be a table: defaults used")
    } else if ("retention_days" in audit) {
      const days = (audit as Record<string, unknown>).retention_days
      if (typeof days === "number" && Number.isInteger(days) && days >= 0) config.audit.retentionDays = days
      // smol-toml reads integers as numbers, or as bigints past 2^53.
      else if (typeof days === "bigint" && days >= 0n) config.audit.retentionDays = Number.MAX_SAFE_INTEGER
      else warnings.push(`audit.retention_days must be a whole number of days, 0 or more: ${DEFAULT_HSI_CONFIG.audit.retentionDays} used`)
    }
  }
  return { config, warnings }
}

/** Read at each use, so an edit applies without restarting HSI. */
export async function loadHsiConfig(file = HSI_CONFIG_FILE): Promise<HsiConfig> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ err: e, file }, "hsi config: unreadable, defaults used")
    return structuredClone(DEFAULT_HSI_CONFIG)
  }
  const { config, warnings } = parseHsiConfig(text)
  for (const w of warnings) log.warn({ file }, `hsi config: ${w}`)
  return config
}
