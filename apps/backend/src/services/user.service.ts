import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import type { PrismaClient, Prisma } from "@brume/database"

export const userSelect = {
  id: true,
  username: true,
  displayName: true,
  linuxUsername: true,
  createdAt: true,
  userRoles: {
    select: {
      role: {
        select: {
          id: true,
          name: true,
          isAdmin: true,
          permissions: { select: { permission: { select: { name: true } } } },
        },
      },
    },
  },
} as const

export async function createUser(
  prisma: PrismaClient,
  input: { username: string; password: string; displayName?: string },
) {
  const existing = await prisma.user.findUnique({ where: { username: input.username } })
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "Username already taken" })

  const hashedPassword = await bcrypt.hash(input.password, 12)

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const user = await tx.user.create({
      data: {
        username: input.username,
        password: hashedPassword,
        displayName: input.displayName ?? null,
      },
      select: userSelect,
    })
    const personalRole = await tx.role.create({ data: { name: input.username } })
    await tx.userRole.create({ data: { userId: user.id, roleId: personalRole.id } })
    return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: userSelect })
  })
}

export async function changePassword(
  prisma: PrismaClient,
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { password: true },
  })
  if (!(await bcrypt.compare(currentPassword, user.password)))
    throw new TRPCError({ code: "FORBIDDEN", message: "Current password is incorrect" })
  const newHashed = await bcrypt.hash(newPassword, 12)
  return prisma.user.update({
    where: { id: userId },
    data: { password: newHashed },
    select: { id: true, username: true },
  })
}
