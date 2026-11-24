import { prisma } from '@app/database'
import { authenticateSession } from '../trpc/session'

export async function loadCurrentUserAuthorization(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      isAdmin: true,
      isUserManager: true,
      mustChangePassword: true,
      capabilities: { select: { capability: true } },
    },
  })
}

export async function authenticateRequest(request: { headers: { authorization?: string } }) {
  return authenticateSession(request.headers.authorization, loadCurrentUserAuthorization)
}
