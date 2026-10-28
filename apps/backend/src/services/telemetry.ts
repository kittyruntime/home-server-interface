import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DAY_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 60 * 60 * 1000
const CLIENT_REVISION = 4
const TELEMETRY_URL = process.env.HSI_TELEMETRY_URL ?? "https://hsi-telemetry.theo-labs.dev/v1/heartbeat"
const DATA_DIR = process.env.INSTALL_DIR ? path.join(process.env.INSTALL_DIR, "data") : path.resolve("data")
const STATE_FILE = path.join(DATA_DIR, "telemetry-last-sent")
let sending = false

export type TelemetryChannel = "stable" | "beta" | "dev"
type Env = Record<string, string | undefined>

/** dev heartbeats are answered but not recorded by the telemetry service. */
export function telemetryChannel(version: string, env: Env = process.env): TelemetryChannel {
  const override = env.HSI_TELEMETRY_CHANNEL?.trim().toLowerCase()
  if (override === "stable" || override === "beta" || override === "dev") return override
  // Installed releases run with NODE_ENV=production; a checkout without a
  // version falls back to v0.0.0.
  if (env.NODE_ENV !== "production" || version === "v0.0.0") return "dev"
  return /^v\d+\.\d+\.\d+-/.test(version) ? "beta" : "stable"
}

export function telemetryDisabledByEnv(env: Env = process.env) {
  return /^(0|false|off|no)$/i.test(env.HSI_TELEMETRY_ENABLED ?? "true")
}

/** Turned off from Settings; HSI_TELEMETRY_ENABLED=false wins over this. */
export async function telemetryDisabledBySettings(dir = DATA_DIR) {
  try {
    return (JSON.parse(await readText(path.join(dir, "telemetry-settings.json"))) as { enabled?: unknown }).enabled === false
  } catch { return false }
}

export async function setTelemetryEnabled(enabled: boolean, dir = DATA_DIR) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(dir, "telemetry-settings.json"), `${JSON.stringify({ enabled })}\n`, { encoding: "utf8", mode: 0o600 })
}

type DiskType = "hdd" | "ssd" | "nvme" | "unknown"

async function readText(filename: string) {
  return fs.readFile(filename, "utf8")
}

export async function getInstallationId(dir = DATA_DIR): Promise<string> {
  const ID_FILE = path.join(dir, "telemetry-installation-id")
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    const id = (await readText(ID_FILE)).trim()
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const id = randomUUID()
  try {
    await fs.writeFile(ID_FILE, `${id}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return (await readText(ID_FILE)).trim()
    throw error
  }
}

export async function getDistroInformation() {
  const fields: Record<string, string> = {}
  try {
    for (const line of (await readText("/etc/os-release")).split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/)
      if (match) fields[match[1]] = match[2].replace(/^['"]|['"]$/g, "").slice(0, 160)
    }
  } catch { /* Linux installations without os-release report unknown. */ }
  return { id: fields.ID || "unknown", name: fields.NAME || "Unknown Linux", version: fields.VERSION_ID || "" }
}

export async function getCpuInformation() {
  const cpus = os.cpus()
  let physicalCores = cpus.length
  try {
    const cpuinfo = await readText("/proc/cpuinfo")
    const pairs = new Set<string>()
    for (const block of cpuinfo.split(/\n\s*\n/)) {
      const physical = block.match(/^physical id\s*:\s*(.+)$/m)?.[1]
      const core = block.match(/^core id\s*:\s*(.+)$/m)?.[1]
      if (physical && core) pairs.add(`${physical}:${core}`)
    }
    if (pairs.size) physicalCores = pairs.size
  } catch { /* os.cpus remains a conservative fallback. */ }
  return { model: (cpus[0]?.model || "Unknown CPU").slice(0, 160), physical_cores: physicalCores, logical_cores: cpus.length }
}

export function getMemoryInformation() {
  return { total_bytes: os.totalmem() }
}

export async function getDiskInformation() {
  const entries = await fs.readdir("/sys/block", { withFileTypes: true }).catch(() => [])
  const ignored = /^(loop|ram|zram|dm-|md)/
  // /sys/block entries are symlinks on most Linux distributions.
  const disks = await Promise.all(entries.filter(e => (e.isDirectory() || e.isSymbolicLink()) && !ignored.test(e.name)).slice(0, 128).map(async entry => {
    const base = path.join("/sys/block", entry.name)
    const [sectors, rotational] = await Promise.all([
      readText(path.join(base, "size")).catch(() => "0"),
      readText(path.join(base, "queue/rotational")).catch(() => ""),
    ])
    const size = Number.parseInt(sectors.trim(), 10) * 512
    const type: DiskType = entry.name.startsWith("nvme") ? "nvme" : rotational.trim() === "1" ? "hdd" : rotational.trim() === "0" ? "ssd" : "unknown"
    return { name: entry.name.slice(0, 64), type, size_bytes: size }
  }))
  return disks.filter(d => Number.isSafeInteger(d.size_bytes) && d.size_bytes > 0)
}

async function getHsiVersion() {
  if (process.env.HSI_VERSION) return process.env.HSI_VERSION
  const installRoot = process.env.INSTALL_DIR ? path.resolve(process.env.INSTALL_DIR) : process.cwd()
  try {
    const version = (await readText(path.join(installRoot, "VERSION"))).trim()
    if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return version
  } catch { /* Development checkouts may not have a VERSION file. */ }
  // Source mode: the installed package.json, else the workspace root one when
  // the backend is started from apps/backend (whose package has no version).
  const candidates = [
    path.join(installRoot, "package.json"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../package.json"),
  ]
  for (const candidate of candidates) {
    try {
      const version: unknown = JSON.parse(await readText(candidate)).version
      if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) return `v${version}`
    } catch { /* try the next one */ }
  }
  return "v0.0.0"
}

export async function getTelemetryPayload(dir = DATA_DIR, env: Env = process.env) {
  const [installation_id, version, distro, cpu, disks] = await Promise.all([
    getInstallationId(dir), getHsiVersion(), getDistroInformation(), getCpuInformation(), getDiskInformation(),
  ])
  return {
    schema_version: 2 as const, channel: telemetryChannel(version, env), installation_id, hsi: { version },
    system: { os: "linux" as const, arch: os.arch(), distro, cpu, memory: getMemoryInformation(), disks },
  }
}

/** What Settings shows: whether heartbeats are sent, and exactly what. */
export async function getTelemetryStatus(dir = DATA_DIR, env: Env = process.env) {
  const disabledBy = telemetryDisabledByEnv(env) ? "environment" as const : await telemetryDisabledBySettings(dir) ? "settings" as const : null
  return { enabled: disabledBy === null, disabledBy, payload: await getTelemetryPayload(dir, env) }
}

export async function shouldSendTelemetry() {
  if (telemetryDisabledByEnv() || await telemetryDisabledBySettings()) return false
  try {
    const raw = (await readText(STATE_FILE)).trim()
    const state = raw.startsWith("{") ? JSON.parse(raw) as { sentAt?: unknown; clientRevision?: unknown } : { sentAt: Number.parseInt(raw, 10), clientRevision: 0 }
    const lastSent = typeof state.sentAt === "number" ? state.sentAt : Number.NaN
    return state.clientRevision !== CLIENT_REVISION || !Number.isFinite(lastSent) || Date.now() - lastSent >= DAY_MS
  } catch { return true }
}

export async function sendTelemetry() {
  if (sending || !(await shouldSendTelemetry())) return false
  sending = true
  try {
    const endpoint = new URL(TELEMETRY_URL)
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return false
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await getTelemetryPayload()),
      signal: AbortSignal.timeout(10_000), redirect: "error",
    })
    if (!response.ok) return false
    await fs.writeFile(STATE_FILE, `${JSON.stringify({ sentAt: Date.now(), clientRevision: CLIENT_REVISION })}\n`, { encoding: "utf8", mode: 0o600 })
    return true
  } catch { return false } finally { sending = false }
}

// Installations restarted together (after an update) do not all report at once.
export function firstHeartbeatDelay(random = Math.random) {
  return Math.floor(random() * RETRY_MS)
}

export function startTelemetry(log?: { warn: (message: string) => void }) {
  let timer: NodeJS.Timeout | undefined
  const schedule = (delay: number) => {
    timer = setTimeout(() => void run(), delay)
    timer.unref()
  }
  const run = async () => {
    const sent = await sendTelemetry()
    if (!sent && await shouldSendTelemetry()) {
      log?.warn("Anonymous telemetry heartbeat failed; retrying in one hour")
      schedule(RETRY_MS)
      return
    }
    schedule(DAY_MS)
  }
  schedule(firstHeartbeatDelay())
}
