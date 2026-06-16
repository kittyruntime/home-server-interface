import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import type { PrismaClient } from "@app/database"
import { signToken, hasPermission } from "../trpc/auth"

export async function loginUser(
  prisma: PrismaClient,
  username: string,
  password: string,
): Promise<{ token: string }> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      password: true,
      userRoles: {
        select: {
          role: {
            select: {
              isAdmin: true,
              permissions: { select: { permission: { select: { name: true } } } },
            },
          },
        },
      },
    },
  })

  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" })
  }

  const isAdmin = user.userRoles.some(ur => ur.role.isAdmin)
  const allPerms = user.userRoles.flatMap(ur =>
    ur.role.permissions.map(rp => rp.permission.name)
  )
  const canManageUsers = isAdmin || hasPermission(allPerms, "users.manage")

  return { token: signToken(user.id, isAdmin, canManageUsers) }
}
