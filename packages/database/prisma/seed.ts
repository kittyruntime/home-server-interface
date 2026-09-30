import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  // Admin user: hash the password only when needed (cost 12 is slow).
  // Re-hash if the stored value is plaintext (doesn't start with "$2").
  const existing = await prisma.user.findUnique({
    where: { username: "admin" },
    select: { id: true, password: true },
  })
  const needsHash = !existing || !existing.password.startsWith("$2")
  const hashedPassword = needsHash ? await bcrypt.hash("admin", 12) : existing.password
  await prisma.user.upsert({
    where:  { username: "admin" },
    update: needsHash ? { password: hashedPassword, isAdmin: true } : { isAdmin: true },
    // mustChangePassword only applies here, at creation; an update to an
    // already-existing admin account never re-imposes it.
    create: { username: "admin", password: hashedPassword, isAdmin: true, mustChangePassword: true },
  })

  console.log("Seeded admin user")
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    prisma.$disconnect()
    process.exit(1)
  })
