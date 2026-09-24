import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { TRPCError } from "@trpc/server"
import { parseComposeYaml, type AppInput } from "@app/compose"
import { requestSync } from "../nats"

export const STACKS_DIR = process.env.HSI_CONTAINERS_DIR ?? "/opt/containers"

export function stackFilePath(name: string): string {
  return path.join(STACKS_DIR, name, "compose.yaml")
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex")
}

export interface StackSummary {
  name: string
  path: string
  hash: string
  app: AppInput | null
  services: string[]
  unknownFields: string[]
  rawYaml: string
  observed: Array<{ name: string; status: string }>
  status: string
  pendingApply: boolean
  drifted: boolean
}

// Last content written by this backend process, per stack name (drift = the
// file on disk no longer matches what HSI wrote last). In-memory on purpose:
// HSI-side cache of observed state, allowed by the architecture principle.
const lastWritten = new Map<string, string>()

export function markStackWritten(name: string, hash: string) { lastWritten.set(name, hash) }

export function stackStatus(observed: Array<{ status: string }>): string {
  if (!observed.length) return "unknown"
  if (observed.some(c => c.status === "running")) return "running"
  return "stopped"
}

export async function scanStacks(): Promise<Array<{ name: string; content: string; hash: string }>> {
  let entries: string[]
  try { entries = await readdir(STACKS_DIR) } catch { return [] }
  const out: Array<{ name: string; content: string; hash: string }> = []
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue
    try {
      const st = await stat(path.join(STACKS_DIR, name))
      if (!st.isDirectory()) continue
      const content = await readFile(stackFilePath(name), "utf8")
      out.push({ name, content, hash: sha256(content) })
    } catch { /* no compose.yaml or unreadable - skip */ }
  }
  return out
}

type ObservedContainer = {
  name: string; image: string; status: string
  ports: Array<{ hostPort: number; containerPort: number; protocol: string }>
  labels: Record<string, string>
  volumes: Array<{ type: string; source: string; target: string }>
  networkNames: string[]
}

async function observedContainers(): Promise<ObservedContainer[]> {
  try { return await requestSync<ObservedContainer[]>("root.container.listAll", {}, 10_000) }
  catch { return [] }
}

function observedForStack(all: ObservedContainer[], name: string, services: string[]): ObservedContainer[] {
  return all.filter(c =>
    c.labels["com.docker.compose.project"] === name ||
    (c.labels["com.docker.compose.service"] && services.includes(c.labels["com.docker.compose.service"])) ||
    services.includes(c.name),
  )
}

export async function listStacks() {
  const [scanned, all] = await Promise.all([scanStacks(), observedContainers()])
  return scanned.map(s => {
    const parsed = parseComposeYaml(s.content)
    const observed = observedForStack(all, s.name, parsed.services)
    const status = stackStatus(observed)
    const pendingApply = parsed.services.length > 0 &&
      !observed.some(c => c.labels["com.docker.compose.project"] === s.name)
    const lw = lastWritten.get(s.name)
    return {
      name: s.name, path: path.dirname(stackFilePath(s.name)), hash: s.hash,
      app: parsed.app, services: parsed.services, unknownFields: parsed.unknownFields,
      rawYaml: s.content, observed, status,
      pendingApply, drifted: lw !== undefined && lw !== s.hash,
    }
  })
}

export async function getStack(name: string) {
  const stacks = await listStacks()
  const found = stacks.find(s => s.name === name)
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" })
  return found
}

export async function stackExists(name: string): Promise<boolean> {
  try { await stat(stackFilePath(name)); return true } catch { return false }
}

export async function writeStack(name: string, content: string): Promise<string> {
  const dir = path.join(STACKS_DIR, name)
  await mkdir(dir, { recursive: true })
  const hash = sha256(content)
  const tmp = path.join(dir, `.compose-${process.pid}-${Date.now()}.tmp`)
  await writeFile(tmp, content, "utf8")
  await rename(tmp, stackFilePath(name))
  markStackWritten(name, hash)
  return hash
}

export async function removeStackDir(name: string): Promise<void> {
  await rm(path.join(STACKS_DIR, name), { recursive: true, force: true })
  lastWritten.delete(name)
}

export async function observedNetworks(): Promise<Array<{ name: string; driver: string }>> {
  try { return await requestSync<Array<{ name: string; driver: string }>>("root.container.networksList", {}, 10_000) }
  catch { return [] }
}

export type DockerContainerLite = { name: string; status: string; ports?: Array<{ hostPort: number; protocol: string }> }
let dockerCache: { at: number; list: DockerContainerLite[] } | null = null
export async function dockerContainers(): Promise<DockerContainerLite[]> {
  if (dockerCache && Date.now() - dockerCache.at < 5_000) return dockerCache.list
  let list: DockerContainerLite[] = []
  try { list = await requestSync<DockerContainerLite[]>("root.container.listAll", {}, 10_000) }
  catch { /* worker/docker unavailable - treat as empty */ }
  dockerCache = { at: Date.now(), list }
  return list
}
