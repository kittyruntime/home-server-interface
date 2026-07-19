import bcrypt from "bcryptjs"
import { TRPCError } from "@trpc/server"
import type { PrismaClient } from "@app/database"
import { signToken } from "../trpc/auth"
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
      isAdmin: true,
      isUserManager: true,
    },
  })

  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" })
  }

  // Fire-and-forget: keeps Linux/Samba passwords in sync for accounts that
  // never changed their password since the sharing feature shipped.
  void syncSystemPassword(prisma, user.id, password)

  const isAdmin = user.isAdmin
  const isUserManager = user.isAdmin || user.isUserManager

  return { token: signToken(user.id, isAdmin, isUserManager) }
}
