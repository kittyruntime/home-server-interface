import assert from "node:assert/strict"

// Set the secret before loading auth.ts: it is captured at module evaluation.
process.env.JWT_SECRET = "backend-tests-only-secret-at-least-32-characters"

const {
  blacklistToken,
  signFileToken,
  signToken,
  verifyFileToken,
  verifyToken,
} = await import("../trpc/auth")
const { authenticateSession } = await import("../trpc/session")
const {
  deleteUpload,
  beginUploadWrite,
  cancelUpload,
  claimUpload,
  clearUploadCancellation,
  endUploadWrite,
  getUploadForOwner,
  getUploadPhase,
  hasUploadFinalizationStarted,
  isUploadCancellationPending,
  markUploadActive,
  markUploadCancellationPending,
  resolveUploadTotalBytes,
  setUpload,
  waitForUploadWrites,
} = await import("../services/upload.service")
type UploadState = import("../services/upload.service").UploadState

async function testCurrentAuthorizationWinsOverJwtClaims() {
  const token = signToken("user-1", true, true, ["storage"], false)
  const user = await authenticateSession(`Bearer ${token}`, async () => ({
    isAdmin: false,
    isUserManager: false,
    mustChangePassword: false,
    capabilities: [],
  }))

  assert.ok(user)
  assert.equal(user.userId, "user-1")
  assert.equal(user.isAdmin, false)
  assert.equal(user.isUserManager, false)
  assert.deepEqual(user.capabilities, [])
}

async function testDeletedAndLoggedOutAccountsAreRejected() {
  const deletedToken = signToken("deleted-user", false, false, [], false)
  assert.equal(await authenticateSession(`Bearer ${deletedToken}`, async () => null), null)

  const loggedOutToken = signToken("logged-out-user", false, false, [], false)
  blacklistToken(verifyToken(loggedOutToken).jti)
  assert.equal(await authenticateSession(`Bearer ${loggedOutToken}`, async () => ({
    isAdmin: false,
    isUserManager: false,
    mustChangePassword: false,
    capabilities: [],
  })), null)
}

async function testDatabaseFailuresAreNotHiddenAsInvalidSessions() {
  const token = signToken("user-2", false, false, [], false)
  await assert.rejects(
    authenticateSession(`Bearer ${token}`, async () => { throw new Error("database unavailable") }),
    /database unavailable/,
  )
}

function testFileTokensDoNotCarryAuthorizationClaims() {
  const payload = verifyFileToken(signFileToken("user-3", "/data/file.txt"))
  assert.equal(payload.userId, "user-3")
  assert.equal(payload.path, "/data/file.txt")
  assert.equal("isAdmin" in payload, false)
}

async function testUploadsAreScopedToTheirOwner() {
  const id = "owner-isolation-test"
  const state: UploadState = {
    ownerUserId: "owner-a",
    received: new Set([0]),
    totalChunks: 1,
    fileName: "file.txt",
    destDir: "/data",
    tempPath: "/data/.upload-owner-isolation-test.part",
    linuxUser: "owner-a",
    allowedRoot: "/data",
    createdAt: 1,
    lastActivityAt: 1,
    totalBytes: 4,
    activeWrites: 0,
    cancelled: false,
    writeIdleWaiters: [],
  }

  setUpload(id, state)
  assert.equal(getUploadForOwner(id, "owner-a"), state)
  assert.equal(getUploadForOwner(id, "owner-b"), undefined)
  assert.equal(hasUploadFinalizationStarted(state), false)
  assert.equal(beginUploadWrite(state), true)
  assert.equal(state.activeWrites, 1)
  endUploadWrite(state)
  assert.equal(state.activeWrites, 0)
  assert.equal(await waitForUploadWrites(state), undefined)
  state.finalizeSha = "a".repeat(64)
  assert.equal(hasUploadFinalizationStarted(state), true)
  assert.equal(beginUploadWrite(state), false)
  state.finalizeSha = undefined
  cancelUpload(state)
  assert.equal(beginUploadWrite(state), false)
  markUploadActive(state)
  assert.ok(state.lastActivityAt > 1)
  deleteUpload(id)
}

function testCancellationWinsTheInitializationRace() {
  const id = "cancel-init-race"
  const state: UploadState = {
    ownerUserId: "owner-c",
    received: new Set(),
    totalChunks: 1,
    fileName: "file.txt",
    destDir: "/data",
    tempPath: "/data/.upload-cancel-init-race.part",
    linuxUser: "owner-c",
    allowedRoot: "/data",
    createdAt: 1,
    lastActivityAt: 1,
    totalBytes: 4,
    activeWrites: 0,
    cancelled: false,
    writeIdleWaiters: [],
  }

  markUploadCancellationPending(id, "owner-c")
  assert.equal(isUploadCancellationPending(id, "owner-c"), true)
  assert.deepEqual(claimUpload(id, state), { cancelled: true })
  assert.equal(getUploadForOwner(id, "owner-c"), undefined)

  // Tombstones are scoped: another owner cannot cancel this owner's id.
  assert.equal(isUploadCancellationPending(id, "owner-d"), false)
  clearUploadCancellation(id, "owner-c")
  const claimed = claimUpload(id, state)
  assert.equal(claimed.cancelled, false)
  if (!claimed.cancelled) {
    assert.equal(claimed.created, true)
    assert.equal(claimed.state, state)
  }
  deleteUpload(id)
}

function testUploadSizeCompatibilityAndLifecyclePhases() {
  assert.equal(resolveUploadTotalBytes("4"), 4)
  assert.equal(resolveUploadTotalBytes(undefined, { totalBytes: 4 }), 4)
  assert.equal(resolveUploadTotalBytes(undefined), null)
  assert.equal(resolveUploadTotalBytes("4.5"), null)
  assert.equal(resolveUploadTotalBytes("9007199254740992"), null)

  const state: UploadState = {
    ownerUserId: "owner-e",
    received: new Set([0]),
    totalChunks: 1,
    fileName: "file.txt",
    destDir: "/data",
    tempPath: "/data/.upload-phase-test.part",
    linuxUser: "owner-e",
    allowedRoot: "/data",
    createdAt: 1,
    lastActivityAt: 1,
    totalBytes: 4,
    activeWrites: 0,
    cancelled: false,
    writeIdleWaiters: [],
  }
  assert.equal(getUploadPhase(state), "staged")
  state.finalizeSha = "a".repeat(64)
  assert.equal(getUploadPhase(state, "running"), "finalizing")
  assert.equal(getUploadPhase(state, "failed"), "failed")
  assert.equal(getUploadPhase(state, "completed"), "completed")
  state.cancelled = true
  assert.equal(getUploadPhase(state, "completed"), "cancelled")
}

await testCurrentAuthorizationWinsOverJwtClaims()
await testDeletedAndLoggedOutAccountsAreRejected()
await testDatabaseFailuresAreNotHiddenAsInvalidSessions()
testFileTokensDoNotCarryAuthorizationClaims()
await testUploadsAreScopedToTheirOwner()
testCancellationWinsTheInitializationRace()
testUploadSizeCompatibilityAndLifecyclePhases()

const { stackStatus } = await import("../services/containerStacks")

function testStackStatusAggregation() {
  assert.equal(stackStatus([]), "unknown")
  assert.equal(stackStatus([{ status: "running" }]), "running")
  assert.equal(stackStatus([{ status: "running" }, { status: "exited" }]), "running")
  assert.equal(stackStatus([{ status: "exited" }, { status: "created" }]), "stopped")
}
testStackStatusAggregation()

console.log("Backend security tests passed")
