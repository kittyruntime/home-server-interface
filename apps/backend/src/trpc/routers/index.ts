import { router } from "../index"
import { authRouter } from "./auth"
import { userRouter } from "./user"
import { placeRouter } from "./place"
import { fsRouter } from "./fs"
import { groupRouter } from "./group"
import { permissionRouter } from "./permission"
import { tasksRouter } from "./tasks"
import { containerRouter } from "./container"
import { systemRouter } from "./system"
import { storageRouter } from "./storage"
import { updateRouter } from "./update"
import { wallpaperRouter } from "./wallpaper"
import { auditRouter } from "./audit"
import { sharingRouter } from "./sharing"
import { shareLinkRouter } from "./shareLink"
import { catalogRouter } from "./catalog"
import { alertRouter } from "./alert"
import { notificationsRouter } from "./notifications"
import { backupRouter } from "./backup"

export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  place: placeRouter,
  fs: fsRouter,
  group: groupRouter,
  permission: permissionRouter,
  tasks: tasksRouter,
  container: containerRouter,
  system: systemRouter,
  storage: storageRouter,
  update: updateRouter,
  wallpaper: wallpaperRouter,
  audit: auditRouter,
  sharing: sharingRouter,
  shareLink: shareLinkRouter,
  catalog: catalogRouter,
  alert: alertRouter,
  notifications: notificationsRouter,
  backup: backupRouter,
})

export type AppRouter = typeof appRouter
