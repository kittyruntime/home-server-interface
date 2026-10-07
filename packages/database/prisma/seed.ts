import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  // No default account (#12): a fresh install creates its administrator in the
  // first-run setup assistant. An "admin" account from an older install still
  // gets its plaintext password hashed (cost 12 is slow, so only when needed).
  const existing = await prisma.user.findUnique({
    where: { username: "admin" },
    select: { id: true, password: true },
  })
  if (existing && !existing.password.startsWith("$2")) {
    await prisma.user.update({ where: { id: existing.id }, data: { password: await bcrypt.hash(existing.password, 12) } })
    console.log("Hashed the admin password")
  }

  // install.sh prints the setup link when it sees this marker.
  const admins = await prisma.user.count({ where: { isAdmin: true } })
  if (admins === 0) console.log("HSI_SETUP_REQUIRED")
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    prisma.$disconnect()
    process.exit(1)
  })
