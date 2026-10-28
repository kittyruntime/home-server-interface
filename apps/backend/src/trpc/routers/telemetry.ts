import { z } from "zod"
import { router, adminProcedure } from "../index"
import { getTelemetryStatus, setTelemetryEnabled } from "../../services/telemetry"

export const telemetryRouter = router({
  status: adminProcedure.query(() => getTelemetryStatus()),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await setTelemetryEnabled(input.enabled)
      return getTelemetryStatus()
    }),
})
