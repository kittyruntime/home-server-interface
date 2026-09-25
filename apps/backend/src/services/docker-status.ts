import { TRPCError } from "@trpc/server"
import { requestSync } from "../nats"

export type DockerStatus = { installed: boolean; running: boolean; compose: boolean; detail?: string }

const CACHE_MS = 10_000
let cached: { at: number; status: DockerStatus } | null = null

/** Docker availability on the host, cached briefly: every apps request checks it. */
export async function getDockerStatus(force = false): Promise<DockerStatus> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.status
  const status = await requestSync<DockerStatus>("root.docker.status", {}, 15_000)
  cached = { at: Date.now(), status }
  return status
}

export function dockerProblem(s: DockerStatus): string | null {
  if (!s.installed) return "Docker is not installed on the server. Install it with: sudo apt install docker.io docker-compose-v2"
  if (!s.running) return "Docker is installed but its service is not running. Start it with: sudo systemctl enable --now docker"
  if (!s.compose) return "The Docker Compose plugin is missing. Install it with: sudo apt install docker-compose-v2"
  return null
}

/** Refuse an apps/App Store action that would fail without a usable Docker. */
export async function assertDockerReady(): Promise<void> {
  const problem = dockerProblem(await getDockerStatus())
  if (problem) throw new TRPCError({ code: "PRECONDITION_FAILED", message: problem })
}
