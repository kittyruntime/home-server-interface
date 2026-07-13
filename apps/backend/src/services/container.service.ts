import { TRPCError } from "@trpc/server"
import type { PrismaClient } from "@app/database"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PortMapping {
  hostPort:      number
  containerPort: number
  protocol:      "tcp" | "udp"
}

export interface EnvVar {
  key:   string
  value: string
}

export interface VolumeMount {
  type:     "bind" | "named" | "place"
  source:   string
  target:   string
  readOnly: boolean
}

export interface LabelEntry {
  key:   string
  value: string
}

export interface AppConfig {
  name:          string
  image:         string
  ports:         PortMapping[]
  envs:          EnvVar[]
  volumes:       VolumeMount[]
  networkNames:  string[]
  labels:        LabelEntry[]
  capAdd:        string[]
  capDrop:       string[]
  extraHosts:    string[]
  restartPolicy: string
  hostname?:     string | null
  user?:         string | null
  command?:      string | null
  cpuLimit?:     number | null
  memoryLimit?:  string | null
  pinnedUrl?:    string | null
}

export interface NetworkConfig {
  name:     string
  driver?:  string
  subnet?:  string | null
  gateway?: string | null
}

export interface VolumeConfig {
  name:        string
  volumeType?: string
  sourcePath?: string | null
  placeId?:    string | null
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function enc(v: unknown): string {
  return JSON.stringify(v)
}

function dec<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

// ── App service ───────────────────────────────────────────────────────────────

export async function listApps(prisma: PrismaClient) {
  const rows = await prisma.containerApp.findMany({ orderBy: { createdAt: "asc" } })
  return rows.map(deserializeApp)
}

export async function getApp(prisma: PrismaClient, id: string) {
  const row = await prisma.containerApp.findUnique({ where: { id } })
  if (!row) throw new TRPCError({ code: "NOT_FOUND" })
  return deserializeApp(row)
}

export async function createApp(prisma: PrismaClient, config: AppConfig) {
  const existing = await prisma.containerApp.findUnique({ where: { name: config.name } })
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "An app with this name already exists" })
  const row = await prisma.containerApp.create({ data: serializeApp(config) })
  return deserializeApp(row)
}

export async function updateApp(prisma: PrismaClient, id: string, config: Partial<AppConfig>) {
  const row = await prisma.containerApp.findUnique({ where: { id } })
  if (!row) throw new TRPCError({ code: "NOT_FOUND" })
  const updated = await prisma.containerApp.update({
    where: { id },
    data:  serializeApp({ ...deserializeApp(row), ...config }),
  })
  return deserializeApp(updated)
}

export async function deleteApp(prisma: PrismaClient, id: string) {
  const row = await prisma.containerApp.findUnique({ where: { id } })
  if (!row) throw new TRPCError({ code: "NOT_FOUND" })
  await prisma.containerApp.delete({ where: { id } })
  return { id }
}

export async function setAppStatus(prisma: PrismaClient, id: string, status: string) {
  try {
    await prisma.containerApp.update({ where: { id }, data: { status } })
  } catch {
    // app may have been deleted — silently ignore
  }
}

// ── Network service ───────────────────────────────────────────────────────────

export async function listNetworks(prisma: PrismaClient) {
  return prisma.containerNetwork.findMany({ orderBy: { createdAt: "asc" } })
}

export async function createNetwork(prisma: PrismaClient, input: NetworkConfig) {
  const existing = await prisma.containerNetwork.findUnique({ where: { name: input.name } })
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "A network with this name already exists" })
  return prisma.containerNetwork.create({
    data: {
      name:    input.name,
      driver:  input.driver  ?? "bridge",
      subnet:  input.subnet  ?? null,
      gateway: input.gateway ?? null,
    },
  })
}

export async function deleteNetwork(prisma: PrismaClient, id: string) {
  const row = await prisma.containerNetwork.findUnique({ where: { id } })
  if (!row) throw new TRPCError({ code: "NOT_FOUND" })
  await prisma.containerNetwork.delete({ where: { id } })
  return { id }
}

// ── Volume service ────────────────────────────────────────────────────────────

export async function listVolumes(prisma: PrismaClient) {
  return prisma.containerVolume.findMany({ orderBy: { createdAt: "asc" } })
}

export async function createVolume(prisma: PrismaClient, input: VolumeConfig) {
  const existing = await prisma.containerVolume.findUnique({ where: { name: input.name } })
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "A volume with this name already exists" })
  return prisma.containerVolume.create({
    data: {
      name:       input.name,
      volumeType: input.volumeType  ?? "named",
      sourcePath: input.sourcePath  ?? null,
      placeId:    input.placeId     ?? null,
    },
  })
}

export async function deleteVolume(prisma: PrismaClient, id: string) {
  const row = await prisma.containerVolume.findUnique({ where: { id } })
  if (!row) throw new TRPCError({ code: "NOT_FOUND" })
  await prisma.containerVolume.delete({ where: { id } })
  return { id }
}

// ── Internal serialization ────────────────────────────────────────────────────

type AppRow = {
  id: string; name: string; image: string
  ports: string; envs: string; volumes: string
  networkNames: string; labels: string
  capAdd: string; capDrop: string; extraHosts: string
  restartPolicy: string
  hostname: string | null; user: string | null; command: string | null
  cpuLimit: number | null; memoryLimit: string | null
  pinnedUrl: string | null
  status: string; createdAt: Date; updatedAt: Date
}

function serializeApp(config: AppConfig) {
  return {
    name:          config.name,
    image:         config.image,
    ports:         enc(config.ports         ?? []),
    envs:          enc(config.envs          ?? []),
    volumes:       enc(config.volumes       ?? []),
    networkNames:  enc(config.networkNames  ?? []),
    labels:        enc(config.labels        ?? []),
    capAdd:        enc(config.capAdd        ?? []),
    capDrop:       enc(config.capDrop       ?? []),
    extraHosts:    enc(config.extraHosts    ?? []),
    restartPolicy: config.restartPolicy ?? "no",
    hostname:      config.hostname    ?? null,
    user:          config.user        ?? null,
    command:       config.command     ?? null,
    cpuLimit:      config.cpuLimit    ?? null,
    memoryLimit:   config.memoryLimit ?? null,
    pinnedUrl:     config.pinnedUrl   ?? null,
  }
}

function deserializeApp(row: AppRow) {
  return {
    id:            row.id,
    name:          row.name,
    image:         row.image,
    ports:         dec<PortMapping[]>(row.ports,        []),
    envs:          dec<EnvVar[]>(row.envs,             []),
    volumes:       dec<VolumeMount[]>(row.volumes,     []),
    networkNames:  dec<string[]>(row.networkNames,     []),
    labels:        dec<LabelEntry[]>(row.labels,       []),
    capAdd:        dec<string[]>(row.capAdd,           []),
    capDrop:       dec<string[]>(row.capDrop,          []),
    extraHosts:    dec<string[]>(row.extraHosts,       []),
    restartPolicy: row.restartPolicy,
    hostname:      row.hostname,
    user:          row.user,
    command:       row.command,
    cpuLimit:      row.cpuLimit,
    memoryLimit:   row.memoryLimit,
    pinnedUrl:     row.pinnedUrl,
    status:        row.status,
    createdAt:     row.createdAt,
    updatedAt:     row.updatedAt,
  }
}
