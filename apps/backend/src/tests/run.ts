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

// STACKS_DIR is captured at module evaluation: point it at a throwaway dir
// before importing containerStacks (same reason JWT_SECRET is set above).
const { mkdtemp, rm } = await import("node:fs/promises")
const { join } = await import("node:path")
const { tmpdir } = await import("node:os")
const stacksTestDir = await mkdtemp(join(tmpdir(), "hsi-stacks-test-"))
process.env.HSI_CONTAINERS_DIR = stacksTestDir
const { removeStackDir, stackExists, stackStatus, writeStack } = await import("../services/containerStacks")

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

function testStackStatusAggregation() {
  assert.equal(stackStatus([]), "unknown")
  assert.equal(stackStatus([{ status: "running" }]), "running")
  assert.equal(stackStatus([{ status: "running" }, { status: "exited" }]), "running")
  assert.equal(stackStatus([{ status: "exited" }, { status: "created" }]), "stopped")
}
testStackStatusAggregation()

async function testStackFsOpsRejectPathTraversalNames() {
  await assert.rejects(removeStackDir("../escape-test"), /Invalid app name/)
  await assert.rejects(writeStack("../escape-test", "x"), /Invalid app name/)
  const name = "stack-roundtrip-ok"
  assert.equal(await stackExists(name), false)
  const hash = await writeStack(name, "services:\n  app:\n    image: nginx\n")
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(await stackExists(name), true)
  await removeStackDir(name)
  assert.equal(await stackExists(name), false)
}

await testStackFsOpsRejectPathTraversalNames()

await rm(stacksTestDir, { recursive: true, force: true })

const { interpolateTemplate, ruleMatches, selectConnectorIds, renderWebhookRequest, SEVERITY_RANK } = await import("../services/notifications")
type NotificationEvent = import("../services/notifications").NotificationEvent

async function testInterpolateTemplate() {
  const vars = { "event.message": 'Disk usage: 84.2% (warning, threshold 80%)', "event.severity": "warning" }
  // JSON-escaping: quotes and backslashes must not break the JSON body
  assert.equal(
    interpolateTemplate('{"text":"{{event.message}}"}', vars),
    '{"text":"Disk usage: 84.2% (warning, threshold 80%)"}',
  )
  assert.equal(interpolateTemplate('{"m":"{{event.message}}"}', { "event.message": 'a "quoted" \\ value' }), '{"m":"a \\"quoted\\" \\\\ value"}')
  assert.equal(interpolateTemplate('{"m":"{{event.unknown}}"}', vars), '{"m":"{{event.unknown}}"}') // unknown kept as-is
}

async function testRuleMatches() {
  assert.deepEqual(SEVERITY_RANK, { info: 0, warning: 1, critical: 2 })
  const event: NotificationEvent = { type: "alert.raised", severity: "warning", source: "storage.disk-usage", target: "/srv/data", message: "m", time: "t" }
  assert.equal(ruleMatches({ sourcePrefix: "storage.", minSeverity: "warning", enabled: true }, event), true)
  assert.equal(ruleMatches({ sourcePrefix: "container.", minSeverity: "warning", enabled: true }, event), false)
  assert.equal(ruleMatches({ sourcePrefix: "", minSeverity: "critical", enabled: true }, event), false) // severity below min
  assert.equal(ruleMatches({ sourcePrefix: "", minSeverity: "info", enabled: false }, event), false) // disabled rule
  assert.equal(ruleMatches({ sourcePrefix: "", minSeverity: "info", enabled: true }, event), true)
  // cleared events carry the resolved alert's severity
  const cleared: NotificationEvent = { ...event, type: "alert.cleared" }
  assert.equal(ruleMatches({ sourcePrefix: "", minSeverity: "critical", enabled: true }, cleared), false)
}

async function testSelectConnectorIds() {
  const event: NotificationEvent = { type: "alert.raised", severity: "critical", source: "storage.raid", target: "md0", message: "m", time: "t" }
  const rules = [
    { sourcePrefix: "", minSeverity: "warning", enabled: true, connectorIds: '["inapp","w1"]' },
    { sourcePrefix: "storage.", minSeverity: "critical", enabled: true, connectorIds: '["w2"]' },
    { sourcePrefix: "storage.", minSeverity: "info", enabled: false, connectorIds: '["w3"]' },
    { sourcePrefix: "backup.", minSeverity: "info", enabled: true, connectorIds: '["w4"]' },
  ]
  assert.deepEqual(selectConnectorIds(rules, event).sort(), ["inapp", "w1", "w2"].sort())
}

async function testRenderWebhookRequest() {
  const connector = {
    method: "POST",
    url: "https://example.test/hook",
    headers: '{"Content-Type":"application/json","X-Title":"HSI {{event.severity}}"}',
    bodyTemplate: '{"severity":"{{event.severity}}","msg":"{{event.message}}"}',
  }
  const event: NotificationEvent = { type: "alert.raised", severity: "warning", source: "storage.disk-usage", target: "/srv/data", message: 'He said "hi"', time: "2026-09-25T14:03:00.000Z" }
  const rendered = renderWebhookRequest(connector, event)
  assert.equal(rendered.method, "POST")
  assert.equal(rendered.url, "https://example.test/hook")
  assert.equal(rendered.headers["X-Title"], "HSI warning")
  assert.equal(rendered.headers["Content-Type"], "application/json")
  const parsed = JSON.parse(rendered.body) // must be valid JSON even with quotes in message
  assert.equal(parsed.msg, 'He said "hi"')
  // invalid headers JSON degrades to {}
  const bad = renderWebhookRequest({ ...connector, headers: "not json" }, event)
  assert.deepEqual(bad.headers, {})
}

await testInterpolateTemplate()
await testRuleMatches()
await testSelectConnectorIds()
await testRenderWebhookRequest()

const { attemptWebhook } = await import("../services/notifications")

async function testAttemptWebhookRetriesAndReports() {
  let calls = 0
  const fakeFetch = async (_url: any, _init: any) => {
    calls++
    if (calls < 3) throw new Error("boom")
    return new Response("ok", { status: 200 })
  }
  const res = await attemptWebhook(
    { method: "POST", url: "https://example.test/hook", headers: {}, body: "{}" },
    { delays: [0, 0], fetchImpl: fakeFetch as any }, // zero-delay backoff for tests
  )
  assert.equal(calls, 3)
  assert.equal(res.ok, true)
  assert.equal(res.status, 200)

  const resFail = await attemptWebhook(
    { method: "POST", url: "https://example.test/hook", headers: {}, body: "{}" },
    { delays: [0], fetchImpl: (async () => { throw new Error("nope") }) as any },
  )
  assert.equal(resFail.ok, false)
  assert.match(resFail.error ?? "", /nope/)
}

await testAttemptWebhookRetriesAndReports()

const { diffAlerts } = await import("../services/alert-sampler")

async function testDiffAlerts() {
  const prev = [
    { target: "/a", severity: "warning", message: "Disk usage: 81% (warning, threshold 80%)" },
    { target: "/b", severity: "critical", message: "Disk usage: 95% (critical, threshold 90%)" },
    { target: "/skipped", severity: "warning", message: "SMART status: warning" },
  ]
  const found = [
    { target: "/a", severity: "warning" as const, message: "Disk usage: 82% (warning, threshold 80%)" }, // same severity, new message -> silent update
    { target: "/b", severity: "critical" as const, message: "Disk usage: 96% (critical, threshold 90%)" }, // unchanged -> silent
    { target: "/c", severity: "critical" as const, message: "Disk usage: 91% (critical, threshold 90%)" }, // new -> raised
  ]
  const now = "2026-09-25T00:00:00.000Z"
  const { raised, cleared } = diffAlerts("storage.disk-usage", prev, ["/a", "/b", "/c"], found, now)
  assert.equal(raised.length, 1)
  assert.equal(raised[0].type, "alert.raised")
  assert.equal(raised[0].target, "/c")
  // /skipped was not checked this tick -> NOT cleared
  assert.equal(cleared.length, 0)

  // severity escalation re-raises
  const esc = [{ target: "/a", severity: "warning", message: "m" }]
  const foundCrit = [{ target: "/a", severity: "critical" as const, message: "m" }]
  const out2 = diffAlerts("storage.disk-usage", esc, ["/a"], foundCrit, now)
  assert.equal(out2.raised.length, 1)
  assert.equal(out2.raised[0].severity, "critical")

  // cleared: checked but absent from found
  const out3 = diffAlerts("storage.disk-usage", [{ target: "/a", severity: "warning", message: "m" }], ["/a"], [], now)
  assert.equal(out3.cleared.length, 1)
  assert.equal(out3.cleared[0].type, "alert.cleared")
  assert.equal(out3.cleared[0].severity, "warning")
}

await testDiffAlerts()

console.log("Backend security tests passed")
