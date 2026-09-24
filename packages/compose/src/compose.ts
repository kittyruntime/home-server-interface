import { parseDocument, isMap, type YAMLMap } from "yaml"
import { zAppInput, type AppInput, type PortMapping, type EnvVar, type VolumeMount, type LabelEntry } from "./model.js"

const HEADER = "# Managed by HSI - editable by hand, re-read on load.\n"

// Managed keys under services.<name>: everything the forms represent. Anything
// else inside the service (or other top-level sections) is "unknown" and must
// survive a generate-in-place untouched.
const MANAGED_SERVICE_KEYS = [
  "container_name", "image", "ports", "environment", "volumes", "networks",
  "labels", "cap_add", "cap_drop", "extra_hosts", "restart", "hostname",
  "user", "command", "cpus", "mem_limit", "x-hsi",
] as const

function portStr(p: PortMapping): string {
  const proto = p.protocol === "udp" ? "/udp" : ""
  return `${p.hostPort}:${p.containerPort}${proto}`
}

function volumeStr(v: VolumeMount): string {
  return `${v.source}:${v.target}${v.readOnly ? ":ro" : ""}`
}

function ensureMap(doc: any, path: string[]): YAMLMap {
  const node = doc.getIn(path, true)
  if (isMap(node)) return node
  doc.setIn(path, doc.createNode({}))
  return doc.getIn(path, true)
}

function ensureService(doc: any, name: string): YAMLMap {
  const services = ensureMap(doc, ["services"])
  const node = doc.getIn(["services", name], true)
  if (isMap(node)) return node
  services.set(name, doc.createNode({}))
  return doc.getIn(["services", name], true)
}

function setOrDelete(map: YAMLMap, key: string, value: unknown) {
  if (value === undefined || value === null || value === "" ||
      (Array.isArray(value) && value.length === 0)) { map.delete(key); return }
  map.set(key, value)
}

function applyModel(doc: any, name: string, input: AppInput) {
  // Top-level networks come first so that a fresh document ends with the
  // services section, keeping hand-appended services structurally valid.
  if (input.networkNames.length) {
    const nets = ensureMap(doc, ["networks"])
    for (const n of input.networkNames) {
      if (!nets.hasIn([n])) nets.setIn([n], { external: true, name: n })
    }
  }

  const svc = ensureService(doc, name)
  for (const k of MANAGED_SERVICE_KEYS) svc.deleteIn([k])
  setOrDelete(svc, "image", input.image)
  setOrDelete(svc, "ports", input.ports.map(portStr))
  if (input.envs.length) setOrDelete(svc, "environment", Object.fromEntries(input.envs.map(e => [e.key, e.value])))
  setOrDelete(svc, "volumes", input.volumes.map(volumeStr))
  if (input.networkNames.length) setOrDelete(svc, "networks", input.networkNames)
  if (input.labels.length) setOrDelete(svc, "labels", Object.fromEntries(input.labels.map(l => [l.key, l.value])))
  setOrDelete(svc, "cap_add", input.capAdd.length ? input.capAdd : undefined)
  setOrDelete(svc, "cap_drop", input.capDrop.length ? input.capDrop : undefined)
  if (input.extraHosts.length) {
    setOrDelete(svc, "extra_hosts", Object.fromEntries(input.extraHosts.map(h => {
      const i = h.indexOf(":"); return [h.slice(0, i), h.slice(i + 1)]
    })))
  }
  if (input.restartPolicy && input.restartPolicy !== "no") setOrDelete(svc, "restart", input.restartPolicy)
  setOrDelete(svc, "hostname", input.hostname || undefined)
  setOrDelete(svc, "user", input.user || undefined)
  setOrDelete(svc, "command", input.command || undefined)
  setOrDelete(svc, "cpus", input.cpuLimit ?? undefined)
  setOrDelete(svc, "mem_limit", input.memoryLimit || undefined)

  const domainPorts = input.ports.filter(p => p.domain)
  const xhsi: Record<string, unknown> = {}
  if (input.pinnedUrl) xhsi.pinnedUrl = input.pinnedUrl
  if (domainPorts.length) xhsi.ports = domainPorts.map(p => ({
    containerPort: p.containerPort, domain: p.domain, tls: p.tls, publicPort: p.publicPort ?? null,
  }))
  if (Object.keys(xhsi).length) setOrDelete(svc, "x-hsi", xhsi)
  setOrDelete(svc, "container_name", name)
}

export interface ParsedCompose {
  raw: string
  services: string[]
  app: AppInput | null
  unknownFields: string[]
}

export function generateComposeYaml(input: AppInput, existing?: string): string {
  if (input.volumes.some(v => v.type === "place")) {
    throw new Error("place volumes must be resolved to bind paths before generation")
  }
  const doc = parseDocument(existing ?? HEADER)
  applyModel(doc as any, input.name, input)
  return String(doc)
}

export function parseComposeYaml(content: string): ParsedCompose {
  const doc = parseDocument(content)
  const json = (doc.toJS() ?? {}) as Record<string, any>
  const services: string[] = Object.keys(json.services ?? {})
  const unknownFields: string[] = []
  const svcName = services.length === 1 ? services[0] : null
  const svc = svcName ? json.services[svcName] : null

  for (const [k] of Object.entries(json)) {
    if (k === "services" || k === "networks") continue
    unknownFields.push(k)
  }
  if (svc) for (const [k] of Object.entries(svc)) {
    if (!(MANAGED_SERVICE_KEYS as readonly string[]).includes(k)) unknownFields.push(`services.${svcName}.${k}`)
  }
  if (json.networks) for (const k of Object.keys(json.networks)) {
    if (!svc || !Array.isArray(svc.networks) || !svc.networks.includes(k)) unknownFields.push(`networks.${k}`)
  }
  if (json.volumes) for (const k of Object.keys(json.volumes)) unknownFields.push(`volumes.${k}`)

  let app: AppInput | null = null
  if (svc) {
    const ports: PortMapping[] = (Array.isArray(svc.ports) ? svc.ports : []).map((s: string) => {
      const [pc, proto = "tcp"] = s.split("/")
      const [host, cont] = (pc ?? "").split(":")
      return { hostPort: Number(host), containerPort: Number(cont), protocol: proto as "tcp" | "udp" }
    })
    const envs: EnvVar[] = Object.entries(svc.environment ?? {}).map(([key, value]) => ({ key, value: String(value) }))
    const volumes: VolumeMount[] = (Array.isArray(svc.volumes) ? svc.volumes : []).map((s: string) => {
      const [source, target, mode] = s.split(":")
      return { type: (source ?? "").startsWith("/") ? "bind" : "named", source: source ?? "", target: target ?? "", readOnly: mode === "ro" }
    })
    const labels: LabelEntry[] = Object.entries(svc.labels ?? {}).map(([key, value]) => ({ key, value: String(value) }))
    const extraHosts: string[] = Object.entries(svc.extra_hosts ?? {}).map(([h, ip]) => `${h}:${ip}`)
    const domainMeta: any[] = svc["x-hsi"]?.ports ?? []
    for (const dp of domainMeta) {
      const p = ports.find(p => p.containerPort === dp.containerPort)
      if (p && dp.domain) { p.domain = dp.domain; p.tls = !!dp.tls; p.publicPort = dp.publicPort ?? undefined }
    }
    const candidate = {
      name: svcName, image: svc.image ?? "",
      ports, envs, volumes, networkNames: Array.isArray(svc.networks) ? svc.networks : [],
      labels, capAdd: svc.cap_add ?? [], capDrop: svc.cap_drop ?? [], extraHosts,
      restartPolicy: svc.restart ?? "no", hostname: svc.hostname ?? null, user: svc.user ?? null,
      command: typeof svc.command === "string" ? svc.command : null,
      cpuLimit: svc.cpus ?? null, memoryLimit: svc.mem_limit ?? null,
      pinnedUrl: svc["x-hsi"]?.pinnedUrl ?? null,
    }
    const parsed = zAppInput.safeParse(candidate)
    if (parsed.success) app = parsed.data
  }
  return { raw: content, services, app, unknownFields }
}
