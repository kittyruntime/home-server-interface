import { router } from "../index"
import { authRouter } from "./auth"
import { userRouter } from "./user"
import { placeRouter } from "./place"
import { fsRouter } from "./fs"
import { roleRouter } from "./role"
import { permissionRouter } from "./permission"
import { tasksRouter } from "./tasks"
import { containerRouter } from "./container"
import { systemRouter } from "./system"
import { updateRouter } from "./update"
import { wallpaperRouter } from "./wallpaper"
import { auditRouter } from "./audit"
import { sharingRouter } from "./sharing"

export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  place: placeRouter,
  fs: fsRouter,
  role: roleRouter,
  permission: permissionRouter,
  tasks: tasksRouter,
  container: containerRouter,
  system: systemRouter,
  update: updateRouter,
  wallpaper: wallpaperRouter,
  audit: auditRouter,
  sharing: sharingRouter,
})

export type AppRouter = typeof appRouter
