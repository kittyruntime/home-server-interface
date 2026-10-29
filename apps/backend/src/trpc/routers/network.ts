import { z } from "zod"
import { router, adminProcedure } from "../index"
import { requestSync } from "../../nats"

// Network settings (#11). Changes go through the network.ipv4 plan
// (storage.plan / storage.execute); NetworkManager restores the previous
// settings unless the change is confirmed here in time.
export type NetworkInterface = {
  device: string; type: string; state: string; managed: boolean
  connection?: string; uuid?: string; method?: "auto" | "manual" | string
  addresses: string[]; gateway?: string; dns: string[]
  configuredAddresses: string[]; configuredGateway?: string; configuredDns: string[]
}
export type NetworkStatus = { unavailable?: string; container?: string; interfaces: NetworkInterface[]; confirmSeconds: number; pending: string[] }

const zCheckpoint = z.object({ checkpoint: z.string().regex(/^\/org\/freedesktop\/NetworkManager\/Checkpoint\/[0-9]+$/) })

export const networkRouter = router({
  status: adminProcedure.query(() => requestSync<NetworkStatus>("root.net.status", {}, 15_000)),

  // Keep the new settings: the checkpoint is dropped and nothing is restored.
  confirm: adminProcedure.input(zCheckpoint).mutation(({ input }) =>
    requestSync<{ ok: boolean }>("root.net.confirm", input, 15_000)),

  // Put the previous settings back now instead of waiting for the timeout.
  rollback: adminProcedure.input(zCheckpoint).mutation(({ input }) =>
    requestSync<{ ok: boolean }>("root.net.rollback", input, 30_000)),
})
