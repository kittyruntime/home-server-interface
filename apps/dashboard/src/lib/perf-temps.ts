// Temperatures and fans from the hwmon sensors (backend services/hw-sensors.ts),
// read the same way by Monitor and the Temperatures widget. Pure, tested with
// node (tests/perf-temps.test.ts).

export type Sensor = { chip: string; label: string; kind: 'temp' | 'fan'; value: number; max?: number; crit?: number }
export type TempTone = 'ok' | 'warn' | 'bad'

/** Warm at the sensor's own max or 80 C; bad within 5 C of its critical point. */
export function tempTone(s: Sensor): TempTone {
  if (s.crit != null && s.value >= s.crit - 5) return 'bad'
  if ((s.max != null && s.value >= s.max) || s.value >= 80) return 'warn'
  return 'ok'
}

export function hottest(sensors: Sensor[]): Sensor | null {
  return sensors.reduce<Sensor | null>((a, s) => s.kind === 'temp' && (!a || s.value > a.value) ? s : a, null)
}

/** How close to its critical point (else to 100 C), in percent. */
export function tempLevel(s: Sensor): number {
  return Math.max(0, Math.min(100, (s.value / (s.crit ?? 100)) * 100))
}

export const sensorKey = (s: Sensor) => `${s.chip}:${s.label}`

export type ChipKind = 'cpu' | 'nvme' | 'disk' | 'board' | 'gpu'
const CHIP: Record<string, ChipKind> = {
  coretemp: 'cpu', k10temp: 'cpu', zenpower: 'cpu', cpu_thermal: 'cpu', nvme: 'nvme', drivetemp: 'disk',
  acpitz: 'board', amdgpu: 'gpu', nouveau: 'gpu', radeon: 'gpu',
}
/** What a known chip measures; null for the others, shown by their own name. */
export const chipKind = (chip: string): ChipKind | null => CHIP[chip] ?? null
