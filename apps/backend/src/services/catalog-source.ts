import crypto from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  BUNDLED_CATALOG_VERSION, CATALOG, CATALOG_SIGNING_PUBLIC_KEY, CATALOG_URL, DEV_CATALOG_KEY_FINGERPRINT,
  parseCatalogIndex, type AppManifest,
} from "@app/app-catalog"
import { log } from "../utils/log"

// The App Store's catalog (#26): the one bundled in this release, replaced by
// the signed index of the public catalog repository when that one is newer.
// The index is fetched at start and every 12 hours, kept on disk so a restart
// offline still has it, and never replaced by an older one (a replayed old
// index cannot bring back a removed app or an old image).

const STATE_DIR = () => process.env.HSI_CATALOG_DIR ?? "/var/lib/hsi/catalog"
const MAX_INDEX_BYTES = 8 * 1024 * 1024
const REFRESH_EVERY_MS = 12 * 60 * 60 * 1000

export interface CatalogState {
  apps: AppManifest[]
  source: "bundled" | "online"
  version: number
  generatedAt: string | null
  checkedAt: string | null
  /** Why the last check did not apply an index (none when it did, or found nothing newer). */
  error: string | null
  skipped: { id: string; reason: string }[]
}

let state: CatalogState = {
  apps: CATALOG, source: "bundled", version: BUNDLED_CATALOG_VERSION,
  generatedAt: null, checkedAt: null, error: null, skipped: [],
}

/** The apps the App Store offers now. */
export function catalogApps(): AppManifest[] {
  return state.apps
}

export function catalogState(): Omit<CatalogState, "apps"> & { apps: number } {
  return { ...state, apps: state.apps.length }
}

function fingerprint(pem: string): string {
  const der = crypto.createPublicKey(pem).export({ type: "spki", format: "der" })
  return crypto.createHash("sha256").update(der).digest("hex")
}

/** Whether this HSI may trust an online index at all: not with the development key. */
export function onlineCatalogTrusted(key = CATALOG_SIGNING_PUBLIC_KEY): boolean {
  return fingerprint(key) !== DEV_CATALOG_KEY_FINGERPRINT || process.env.HSI_ALLOW_DEV_CATALOG_KEY === "1"
}

/** Checks the raw ed25519 signature (base64) of the index bytes. */
export function verifyCatalog(body: Buffer, signatureB64: string, key = CATALOG_SIGNING_PUBLIC_KEY): boolean {
  const sig = Buffer.from(signatureB64.trim(), "base64")
  if (sig.length !== 64) return false
  try { return crypto.verify(null, body, crypto.createPublicKey(key), sig) } catch { return false }
}

/**
 * Applies a signed index when it is newer than what is in use. Returns why not
 * otherwise, as a message for administrators.
 */
export function applyIndex(body: Buffer, signatureB64: string, hsiVersion: string, opts: { key?: string } = {}): string | null {
  if (!verifyCatalog(body, signatureB64, opts.key)) return "the catalog signature does not match"
  const index = parseCatalogIndex(body.toString("utf8"), hsiVersion)
  if (index.version < state.version) return null // older than what is in use: kept as is
  if (index.version === state.version && state.source === "online") return null
  if (index.apps.length === 0) return "the catalog lists no app this HSI can install"
  state = {
    apps: index.apps, source: "online", version: index.version, generatedAt: index.generatedAt,
    checkedAt: state.checkedAt, error: null, skipped: index.skipped,
  }
  return null
}

async function fetchCapped(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "user-agent": "hsi-catalog" } })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const length = Number(res.headers.get("content-length") ?? 0)
  if (length > MAX_INDEX_BYTES) throw new Error("the catalog is too large")
  const body = Buffer.from(await res.arrayBuffer())
  if (body.length > MAX_INDEX_BYTES) throw new Error("the catalog is too large")
  return body
}

async function saveCache(body: Buffer, sig: string) {
  const dir = STATE_DIR()
  await mkdir(dir, { recursive: true, mode: 0o755 })
  for (const [name, data] of [["catalog.json", body], ["catalog.json.sig", sig]] as const) {
    const tmp = path.join(dir, `.${name}.tmp`)
    await writeFile(tmp, data, { mode: 0o644 })
    await rename(tmp, path.join(dir, name))
  }
}

/** Reads the kept index back at start, before any network. */
export async function loadCachedCatalog(hsiVersion: string): Promise<void> {
  if (!onlineCatalogTrusted()) return
  try {
    const dir = STATE_DIR()
    const [body, sig] = await Promise.all([readFile(path.join(dir, "catalog.json")), readFile(path.join(dir, "catalog.json.sig"), "utf8")])
    const why = applyIndex(body, sig, hsiVersion)
    if (why) log.warn({ reason: why }, "catalog: the kept catalog is not used")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ err: (e as Error).message }, "catalog: the kept catalog is unreadable")
  }
}

/** Fetches the index online and applies it when it is newer. */
export async function refreshCatalog(hsiVersion: string, url = CATALOG_URL): Promise<Omit<CatalogState, "apps"> & { apps: number }> {
  const checkedAt = new Date().toISOString()
  if (!onlineCatalogTrusted()) {
    state = { ...state, checkedAt, error: "online catalog updates are off: this HSI has no catalog signing key yet" }
    return catalogState()
  }
  try {
    const [body, sigBuf] = await Promise.all([fetchCapped(url), fetchCapped(`${url}.sig`)])
    const sig = sigBuf.toString("utf8")
    const before = state.version
    const why = applyIndex(body, sig, hsiVersion)
    state = { ...state, checkedAt, error: why }
    if (!why && state.version !== before) {
      await saveCache(body, sig).catch(e => log.warn({ err: (e as Error).message }, "catalog: could not keep the catalog"))
      log.info({ version: state.version, apps: state.apps.length, skipped: state.skipped.length }, "catalog: updated online")
    }
  } catch (e) {
    state = { ...state, checkedAt, error: (e as Error).message }
    log.warn({ err: (e as Error).message }, "catalog: online check failed, the current catalog stays")
  }
  return catalogState()
}

export function startCatalogRefresh(hsiVersion: () => string): void {
  void loadCachedCatalog(hsiVersion()).then(() => refreshCatalog(hsiVersion()))
  setInterval(() => { void refreshCatalog(hsiVersion()) }, REFRESH_EVERY_MS).unref()
}

/** Tests only: back to the bundled catalog. */
export function resetCatalogForTests(): void {
  state = { apps: CATALOG, source: "bundled", version: BUNDLED_CATALOG_VERSION, generatedAt: null, checkedAt: null, error: null, skipped: [] }
}
