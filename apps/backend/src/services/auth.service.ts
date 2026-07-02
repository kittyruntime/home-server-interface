import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import type { PrismaClient } from "@app/database"
import { signToken, hasPermission } from "../trpc/auth"
import { syncSystemPassword } from "./user.service"

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

  // Fire-and-forget: keeps Linux/Samba passwords in sync for accounts that
  // never changed their password since the sharing feature shipped.
  void syncSystemPassword(prisma, user.id, password)

  const isAdmin = user.userRoles.some(ur => ur.role.isAdmin)
  const allPerms = user.userRoles.flatMap(ur =>
    ur.role.permissions.map(rp => rp.permission.name)
  )
  const canManageUsers = isAdmin || hasPermission(allPerms, "users.manage")

  return { token: signToken(user.id, isAdmin, canManageUsers) }
}
