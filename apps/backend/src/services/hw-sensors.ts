import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Temperatures and fans from the kernel's hwmon interface, readable without
// root. Each chip names itself (coretemp, k10temp, nvme, drivetemp, acpitz...).

export type Sensor = { chip: string; label: string; kind: "temp" | "fan"; value: number; max?: number; crit?: number }

const read = (file: string): string | null => {
  try { return readFileSync(file, "utf8").trim() } catch { return null }
}
const num = (file: string): number | null => {
  const v = read(file)
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function readSensors(root = "/sys/class/hwmon"): Sensor[] {
  let chips: string[]
  try { chips = readdirSync(root).filter(d => /^hwmon\d+$/.test(d)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))) }
  catch { return [] }
  const out: Sensor[] = []
  for (const dir of chips) {
    const base = join(root, dir)
    const chip = read(join(base, "name")) ?? dir
    let files: string[]
    try { files = readdirSync(base) } catch { continue }
    const inputs = files.map(f => /^(temp|fan)(\d+)_input$/.exec(f)).filter((m): m is RegExpExecArray => m != null)
      .sort((a, b) => a[1]!.localeCompare(b[1]!) || Number(a[2]) - Number(b[2]))
    for (const m of inputs) {
      const kind = m[1] === "temp" ? "temp" : "fan"
      const prefix = `${m[1]}${m[2]}`
      const raw = num(join(base, `${prefix}_input`))
      if (raw == null) continue
      const label = read(join(base, `${prefix}_label`)) || `${chip} ${m[2]}`
      if (kind === "fan") { out.push({ chip, label, kind, value: raw }); continue }
      const value = raw / 1000
      // Unwired inputs report absurd values (-273, 255).
      if (value <= -40 || value >= 150) continue
      const s: Sensor = { chip, label, kind, value: Math.round(value * 10) / 10 }
      const max = num(join(base, `${prefix}_max`)), crit = num(join(base, `${prefix}_crit`))
      if (max != null && max > 0 && max < 150_000) s.max = max / 1000
      if (crit != null && crit > 0 && crit < 150_000) s.crit = crit / 1000
      out.push(s)
    }
  }
  return out
}
