import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  // Admin user — hash the password only when needed (cost 12 is slow).
  // Re-hash if the stored value is plaintext (doesn't start with "$2").
  const existing = await prisma.user.findUnique({
    where: { username: "admin" },
    select: { id: true, password: true },
  })
  const needsHash = !existing || !existing.password.startsWith("$2")
  const hashedPassword = needsHash ? await bcrypt.hash("admin", 12) : existing.password
  const adminUser = await prisma.user.upsert({
    where:  { username: "admin" },
    update: needsHash ? { password: hashedPassword } : {},
    create: { username: "admin", password: hashedPassword },
  })

  // Admin role (isAdmin grants all access)
  const adminRole = await prisma.role.upsert({
    where: { name: "admin" },
    update: { isAdmin: true },
    create: { name: "admin", isAdmin: true },
  })

  // Assign admin role to admin user
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  })

  // Well-known permissions (glob notation)
  const wellKnown = [
    "*.*",              // all permissions
    "users.manage",     // create / edit / delete users
    "users.*",          // all user permissions
    "places.manage",    // create / edit / delete places
    "places.*",         // all place permissions
    "files.*",          // all file operations
    "files.read",
    "files.write",
    "files.delete",
    "container.*",      // all container operations
    "container.view",   // list / view containers
    "container.create", // create containers
    "container.delete", // delete containers
    "container.manage", // start / stop / restart containers
  ]
  for (const name of wellKnown) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name } })
  }

  console.log("Seeded admin user, roles, and well-known permissions")
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    prisma.$disconnect()
    process.exit(1)
  })
