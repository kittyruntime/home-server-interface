import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { Prisma } from "@app/database"
import { router, protectedProcedure } from "../index"
import { signWallpaperToken } from "../auth"
import { detectImageType } from "../../utils/image-sniff"
import { writeWallpaperFile, deleteWallpaperFile } from "../../services/wallpaper-storage"

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

type WallpaperValue =
  | { kind: "color"; value: string }
  | { kind: "image"; ext: string }

export const wallpaperRouter = router({

  // ── get (sync) ────────────────────────────────────────────────────────────
  get: protectedProcedure.query(async ({ ctx }) => {
    const u = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { wallpaper: true },
    })
    const w = u?.wallpaper as WallpaperValue | null
    if (!w) return { kind: "none" as const }
    if (w.kind === "color") return { kind: "color" as const, value: w.value }
    return { kind: "image" as const }
  }),

  // ── setColor (sync) ───────────────────────────────────────────────────────
  setColor: protectedProcedure
    .input(z.object({ value: z.string().regex(HEX_COLOR) }))
    .mutation(async ({ ctx, input }) => {
      const u = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.userId },
        select: { wallpaper: true },
      })
      const prev = u?.wallpaper as WallpaperValue | null
      if (prev?.kind === "image") await deleteWallpaperFile(ctx.user.userId, prev.ext)

      await ctx.prisma.user.update({
        where: { id: ctx.user.userId },
        data: { wallpaper: { kind: "color", value: input.value } },
      })
      return { ok: true }
    }),

  // ── setImage (sync) ───────────────────────────────────────────────────────
  setImage: protectedProcedure
    .input(z.object({ data: z.string(), mimeType: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const buf = Buffer.from(input.data, "base64")
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Image must be 1 byte to 8 MB" })
      }
      const detected = detectImageType(buf)
      if (!detected) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unrecognized image format (PNG/JPEG/WEBP only)" })
      }

      const u = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.userId },
        select: { wallpaper: true },
      })
      const prev = u?.wallpaper as WallpaperValue | null
      if (prev?.kind === "image" && prev.ext !== detected) {
        await deleteWallpaperFile(ctx.user.userId, prev.ext)
      }

      const ext = detected === "jpeg" ? "jpg" : detected
      await writeWallpaperFile(ctx.user.userId, ext, buf)
      await ctx.prisma.user.update({
        where: { id: ctx.user.userId },
        data: { wallpaper: { kind: "image", ext } },
      })
      return { ok: true }
    }),

  // ── clear (sync) ──────────────────────────────────────────────────────────
  clear: protectedProcedure.mutation(async ({ ctx }) => {
    const u = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { wallpaper: true },
    })
    const prev = u?.wallpaper as WallpaperValue | null
    if (prev?.kind === "image") await deleteWallpaperFile(ctx.user.userId, prev.ext)

    await ctx.prisma.user.update({
      where: { id: ctx.user.userId },
      data: { wallpaper: Prisma.DbNull },
    })
    return { ok: true }
  }),

  // ── createImageToken (sync) ───────────────────────────────────────────────
  createImageToken: protectedProcedure.query(async ({ ctx }) => {
    const u = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { wallpaper: true },
    })
    const w = u?.wallpaper as WallpaperValue | null
    if (w?.kind !== "image") throw new TRPCError({ code: "NOT_FOUND", message: "No wallpaper image set" })
    return { token: signWallpaperToken(ctx.user.userId) }
  }),
})
