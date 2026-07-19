// One-time, idempotent data migration for the Users+Groups permissions redesign.
// This project uses `prisma db push` (no migration history); db push DROPS data on
// destructive changes, so we morph the live DB (schema + data) to match the new
// Prisma schema here FIRST — a subsequent `db push` is then a no-op.
// Run (prod):  pnpm --filter @app/database exec vite-node prisma/data-migrations/2026-07-19-permissions-redesign.ts
// Test (copy): DATABASE_URL="file:/abs/copy.db" pnpm --filter @app/database exec vite-node prisma/data-migrations/2026-07-19-permissions-redesign.ts
import { PrismaClient } from "@prisma/client"

const url = process.env.DATABASE_URL
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient()

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name,
  )
  return rows.length > 0
}

const flags = ["canRead", "canWrite", "canDelete", "canShare"] as const

const STATEMENTS: string[] = [
  // 1. New User flag columns
  `ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT 0`,
  `ALTER TABLE "User" ADD COLUMN "isUserManager" BOOLEAN NOT NULL DEFAULT 0`,
  // 2. isAdmin from members of any isAdmin role
  `UPDATE "User" SET "isAdmin"=1 WHERE "id" IN (SELECT ur."userId" FROM "UserRole" ur JOIN "Role" r ON r."id"=ur."roleId" WHERE r."isAdmin"=1)`,
  // 3. isUserManager from roles granting users.manage / wildcard
  `UPDATE "User" SET "isUserManager"=1 WHERE "id" IN (SELECT ur."userId" FROM "UserRole" ur JOIN "RolePermission" rp ON rp."roleId"=ur."roleId" JOIN "Permission" p ON p."id"=rp."permissionId" WHERE p."name" IN ('users.manage','*','*.*'))`,
  // 4. Rename tables/cols: RolePlacePermission->GroupPlacePermission, Role->Group, UserRole->UserGroup
  `ALTER TABLE "RolePlacePermission" RENAME TO "GroupPlacePermission"`,
  `ALTER TABLE "GroupPlacePermission" RENAME COLUMN "roleId" TO "groupId"`,
  `ALTER TABLE "Role" RENAME TO "Group"`,
  `ALTER TABLE "UserRole" RENAME TO "UserGroup"`,
  `ALTER TABLE "UserGroup" RENAME COLUMN "roleId" TO "groupId"`,
  // 5. Fold personal groups (name==username, single member) into direct UserPlacePermission — insert missing
  `INSERT INTO "UserPlacePermission" ("id","userId","placeId","canRead","canWrite","canDelete","canShare")
   SELECT lower(hex(randomblob(16))), u."id", gpp."placeId", gpp."canRead", gpp."canWrite", gpp."canDelete", gpp."canShare"
   FROM "GroupPlacePermission" gpp JOIN "Group" g ON g."id"=gpp."groupId" JOIN "User" u ON u."username"=g."name"
   JOIN "UserGroup" ug ON ug."groupId"=g."id" AND ug."userId"=u."id"
   WHERE (SELECT COUNT(*) FROM "UserGroup" ug2 WHERE ug2."groupId"=g."id")=1 AND u."isAdmin"=0
     AND NOT EXISTS (SELECT 1 FROM "UserPlacePermission" upp WHERE upp."userId"=u."id" AND upp."placeId"=gpp."placeId")`,
  // 5b. OR-merge booleans where a direct row already existed (one UPDATE per flag)
  ...flags.map(f =>
    `UPDATE "UserPlacePermission" SET "${f}"=1 WHERE ("userId","placeId") IN (
       SELECT u."id", gpp."placeId" FROM "GroupPlacePermission" gpp JOIN "Group" g ON g."id"=gpp."groupId"
       JOIN "User" u ON u."username"=g."name" JOIN "UserGroup" ug ON ug."groupId"=g."id" AND ug."userId"=u."id"
       WHERE (SELECT COUNT(*) FROM "UserGroup" ug2 WHERE ug2."groupId"=g."id")=1 AND gpp."${f}"=1)`),
  // 6. Delete personal groups (perms now live on the user)
  `DELETE FROM "GroupPlacePermission" WHERE "groupId" IN (SELECT g."id" FROM "Group" g JOIN "UserGroup" ug ON ug."groupId"=g."id" JOIN "User" u ON u."id"=ug."userId" AND u."username"=g."name" WHERE (SELECT COUNT(*) FROM "UserGroup" ug2 WHERE ug2."groupId"=g."id")=1)`,
  `DELETE FROM "UserGroup" WHERE "groupId" IN (SELECT g."id" FROM "Group" g JOIN "UserGroup" ug ON ug."groupId"=g."id" JOIN "User" u ON u."id"=ug."userId" AND u."username"=g."name" WHERE (SELECT COUNT(*) FROM "UserGroup" ug2 WHERE ug2."groupId"=g."id")=1)`,
  `DELETE FROM "Group" WHERE "name" IN (SELECT "username" FROM "User") AND "id" NOT IN (SELECT "groupId" FROM "UserGroup") AND "id" NOT IN (SELECT "groupId" FROM "GroupPlacePermission")`,
  // 7. Delete the old admin role/group (isAdmin now a User flag)
  `DELETE FROM "GroupPlacePermission" WHERE "groupId" IN (SELECT "id" FROM "Group" WHERE "name"='admin')`,
  `DELETE FROM "UserGroup" WHERE "groupId" IN (SELECT "id" FROM "Group" WHERE "name"='admin')`,
  `DELETE FROM "Group" WHERE "name"='admin'`,
  // 8. Drop the role-level isAdmin column from Group, obsolete tables, and User.linuxUsername
  //    (root-mapped accounts are re-homed to Linux=username: the app provisions the
  //     Linux/Samba account named = username on next login/password sync.)
  `ALTER TABLE "Group" DROP COLUMN "isAdmin"`,
  `DROP TABLE "RolePermission"`,
  `DROP TABLE "Permission"`,
  `ALTER TABLE "User" DROP COLUMN "linuxUsername"`,
]

async function main() {
  if (!(await tableExists("Role"))) {
    console.log("[permissions-redesign] already migrated (no Role table); nothing to do.")
    return
  }
  console.log("[permissions-redesign] migrating (atomic)…")
  // Single atomic transaction: a failure rolls back and leaves the old schema intact for a safe retry.
  await prisma.$transaction(STATEMENTS.map(s => prisma.$executeRawUnsafe(s)))
  console.log("[permissions-redesign] done.")
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
