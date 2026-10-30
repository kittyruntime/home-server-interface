import assert from "node:assert/strict"
import { TimeoutError } from "@nats-io/transport-node"

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

async function testFullComposeImportCreatesAndProtectsAnApp() {
  const { containerRouter } = await import("../trpc/routers/container")
  const caller = containerRouter.createCaller({
    user: { userId: "test-admin", isAdmin: true, isUserManager: false, mustChangePassword: false, capabilities: [] },
    prisma: { auditLog: { create: async () => ({}) } },
    req: { ip: "127.0.0.1", headers: {} },
    audit: {},
  } as any)
  const content = [
    "services:",
    "  web:",
    "    image: nginx",
    "    depends_on:",
    "      - db",
    "  db:",
    "    image: postgres",
    "networks:",
    "  frontend: {}",
    "volumes:",
    "  data: {}",
  ].join("\n")
  assert.deepEqual(await caller.app.importCompose({ name: "full-compose", content }), {
    name: "full-compose", services: ["web", "db"],
  })
  assert.equal(await stackExists("full-compose"), true)
  await assert.rejects(
    caller.app.importCompose({ name: "full-compose", content }),
    (e: any) => e.code === "CONFLICT",
  )
  await assert.rejects(
    caller.app.importCompose({ name: "empty-compose", content: "services: {}" }),
    (e: any) => e.code === "BAD_REQUEST" && /at least one service/i.test(e.message),
  )
}

await testFullComposeImportCreatesAndProtectsAnApp()

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

const { readJobLogs } = await import("../services/jobLogs")

async function testReadJobLogs() {
  const { writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "hsi-logs-test-"))
  try {
    const job = "6f1c2c1e-0000-4000-8000-000000000001"
    const other = "6f1c2c1e-0000-4000-8000-000000000002"
    await writeFile(join(dir, "app.log"), [
      JSON.stringify({ level: "info", time: "2026-09-28T08:00:00.000Z", component: "backend", pid: 1, msg: "job published", jobId: job, subject: "root.fs.mkdir" }),
      JSON.stringify({ level: "info", time: "2026-09-28T08:00:00.500Z", component: "backend", msg: "job published", jobId: other }),
      JSON.stringify({ level: "warn", time: "2026-09-28T08:00:02.000Z", component: "backend", msg: "job failed", jobId: job }),
      "",
    ].join("\n"))
    // Worker lines use local time with an offset: 10:00:01+02:00 is 08:00:01Z.
    await writeFile(join(dir, "root-worker.log"), [
      JSON.stringify({ time: "2026-09-28T10:00:01.000000000+02:00", level: "warn", msg: "job failed", component: "worker", jobId: job, error: "permission denied" }),
      `panic: something ${job}`,
      "",
    ].join("\n"))

    const lines = await readJobLogs(job, dir)
    assert.equal(lines.length, 4)
    // Unparseable line first, then chronological across both files.
    assert.deepEqual(lines.map(l => `${l.source}:${l.msg}`), [
      `worker:panic: something ${job}`,
      "backend:job published",
      "worker:job failed",
      "backend:job failed",
    ])
    assert.deepEqual(lines[1].fields, { subject: "root.fs.mkdir" })
    assert.equal(lines[2].level, "warn")
    assert.equal(lines[2].fields.error, "permission denied")

    // Missing files are not an error.
    assert.deepEqual(await readJobLogs(job, join(dir, "missing")), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await testReadJobLogs()

const secrets = await import("../services/secrets")

async function testSecrets() {
  const key = Buffer.alloc(32, 7)
  const other = Buffer.alloc(32, 8)

  const enc = secrets.encryptSecret("https://discord.com/api/webhooks/1/abc", key)
  assert.ok(secrets.isEncrypted(enc))
  assert.ok(enc.startsWith("enc:v1:"))
  assert.ok(!enc.includes("discord"))
  assert.equal(secrets.decryptSecret(enc, key), "https://discord.com/api/webhooks/1/abc")
  // Random IV: same plaintext, different ciphertext.
  assert.notEqual(secrets.encryptSecret("x", key), secrets.encryptSecret("x", key))

  assert.throws(() => secrets.decryptSecret(enc, other), (e: Error) => e instanceof secrets.SecretsError && e.message === secrets.UNREADABLE_SECRETS)
  const parts = enc.split(":")
  parts[4] = Buffer.from("tampered").toString("base64")
  assert.throws(() => secrets.decryptSecret(parts.join(":"), key), secrets.SecretsError)
  assert.throws(() => secrets.encryptSecret("x", null), /HSI_SECRETS_KEY missing/)

  // Legacy plaintext is returned as-is; encrypted values need the key.
  assert.equal(secrets.revealSecret("plain", null), "plain")
  assert.equal(secrets.revealSecret(enc, key), "https://discord.com/api/webhooks/1/abc")
  assert.throws(() => secrets.revealSecret(enc, null), /HSI_SECRETS_KEY missing/)

  const prev = process.env.HSI_SECRETS_KEY
  process.env.HSI_SECRETS_KEY = "ab".repeat(32)
  assert.equal(secrets.secretsKey()?.length, 32)
  process.env.HSI_SECRETS_KEY = "too-short"
  assert.equal(secrets.secretsKey(), null)
  if (prev === undefined) delete process.env.HSI_SECRETS_KEY
  else process.env.HSI_SECRETS_KEY = prev
}

await testSecrets()

const conn = await import("../services/notification-connectors")

async function testConnectorShapes() {
  const key = Buffer.alloc(32, 3)
  const webhook = {
    type: "webhook" as const, method: "POST", url: "https://discord.com/api/webhooks/1/secret",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t0k" }, bodyTemplate: "{}",
  }
  const stored = conn.toStoredFields(webhook, key)
  assert.ok(!stored.url.includes("secret"))
  const storedHeaders = JSON.parse(stored.headers)
  assert.equal(storedHeaders["Content-Type"], "application/json")
  assert.ok(storedHeaders.Authorization.startsWith("enc:v1:"))
  assert.deepEqual(conn.resolveStored(stored, key), webhook)

  // Public shape: nothing secret leaves the server.
  const row = { ...stored, id: "c1", name: "d", enabled: true, rateLimitPerMinute: 10, createdAt: new Date() }
  const pub = conn.toPublicConnector(row, key)
  assert.equal(pub.url, "https://discord.com/…")
  assert.deepEqual(JSON.parse(pub.headers), { "Content-Type": "application/json", Authorization: conn.SECRET_MASK })
  assert.equal(pub.secretsUnreadable, false)
  assert.ok(!JSON.stringify(pub).includes("webhooks/1/secret") && !JSON.stringify(pub).includes("t0k"))

  // Saving the masked form keeps every stored secret.
  const kept = conn.mergeConnectorInput(
    { type: "webhook", method: "POST", url: pub.url, headers: pub.headers, bodyTemplate: "{}" },
    webhook,
  )
  assert.deepEqual(kept, webhook)
  // Empty URL keeps too; a new value replaces; a removed header disappears.
  const changed = conn.mergeConnectorInput(
    { type: "webhook", method: "PUT", url: "https://ntfy.sh/topic", headers: '{"Content-Type":"text/plain"}', bodyTemplate: "x" },
    webhook,
  )
  assert.equal(changed.type === "webhook" && changed.url, "https://ntfy.sh/topic")
  assert.deepEqual(changed.type === "webhook" && changed.headers, { "Content-Type": "text/plain" })
  const emptyUrl = conn.mergeConnectorInput({ type: "webhook", method: "POST", url: "", headers: "{}", bodyTemplate: "{}" }, webhook)
  assert.equal(emptyUrl.type === "webhook" && emptyUrl.url, webhook.url)
  // A mask with nothing stored cannot be resolved.
  assert.throws(() => conn.mergeConnectorInput({ type: "webhook", method: "POST", url: pub.url, headers: "{}", bodyTemplate: "" }, null), (e: Error) => e.name === "SecretsError")
  // Invalid URL is rejected.
  assert.throws(() => conn.mergeConnectorInput({ type: "webhook", method: "POST", url: "ftp://x", headers: "{}", bodyTemplate: "" }, null), /http/)

  // SMTP: the password never leaves, an empty password keeps the stored one.
  const smtp = { type: "smtp" as const, smtp: {
    host: "smtp.example.com", port: 587, security: "starttls" as const, username: "nas", password: "pw",
    from: "nas@example.com", to: ["me@example.com"], subjectTemplate: "s", bodyTemplate: "b",
  } }
  const smtpStored = conn.toStoredFields(smtp, key)
  assert.ok(!smtpStored.config.includes('"pw"'))
  const smtpPub = conn.toPublicConnector({ ...smtpStored, id: "c2", name: "m", enabled: true, rateLimitPerMinute: 10, createdAt: new Date() }, key)
  assert.equal(smtpPub.smtp?.passwordSet, true)
  assert.ok(!JSON.stringify(smtpPub).includes('"pw"'))
  const smtpKept = conn.mergeConnectorInput({ type: "smtp", smtp: { ...smtp.smtp, password: "" } }, smtp)
  assert.equal(smtpKept.type === "smtp" && smtpKept.smtp.password, "pw")

  // Wrong key: the public shape flags it instead of throwing.
  const bad = conn.toPublicConnector(row, Buffer.alloc(32, 4))
  assert.equal(bad.secretsUnreadable, true)
  assert.equal(bad.url, conn.SECRET_MASK)

  // Legacy plaintext rows resolve without a key.
  assert.equal((conn.resolveStored({ type: "webhook", method: "POST", url: "https://a.test/x", headers: "{}", bodyTemplate: "", config: "{}" }, null) as any).url, "https://a.test/x")
}

await testConnectorShapes()

const transports = await import("../services/notification-transports")
const nodemailer = (await import("nodemailer")).default

async function testTransports() {
  const event = {
    type: "alert.raised" as const, severity: "critical" as const, source: "storage.raid",
    target: "md0\r\nBcc: evil@example.com", message: "Array degraded", time: "2026-09-28T08:00:00.000Z",
  }

  // Webhook: exactly one attempt, errors reported.
  let calls = 0
  const ok = await transports.sendWebhook(
    { method: "POST", url: "https://example.test/hook", headers: {}, body: "{}" },
    (async () => { calls++; return new Response(null, { status: 204 }) }) as any,
  )
  assert.deepEqual([calls, ok.ok, ok.status], [1, true, 204])
  const http = await transports.sendWebhook({ method: "POST", url: "https://example.test/hook", headers: {}, body: "{}" },
    (async () => new Response("no", { status: 500 })) as any)
  assert.deepEqual([http.ok, http.error], [false, "HTTP 500"])

  // Email rendering: plain interpolation, single-line subject.
  const smtp = {
    host: "smtp.example.com", port: 587, security: "starttls" as const, username: "", password: "",
    from: "nas@example.com", to: ["me@example.com"], subjectTemplate: "[{{event.severity}}] {{event.target}}",
    bodyTemplate: "{{event.message}} \"quoted\"",
  }
  const mail = transports.renderEmail(smtp, event)
  assert.equal(mail.subject, "[critical] md0 Bcc: evil@example.com")
  assert.ok(!/[\r\n]/.test(mail.subject))
  assert.equal(mail.text, "Array degraded \"quoted\"")

  // Delivery through nodemailer's stream transport (no network).
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true })
  let raw = ""
  const sender = { sendMail: async (m: any) => { const info: any = await stream.sendMail(m); raw = info.message.toString(); return info } }
  const sent = await transports.sendEmail(smtp, event, sender)
  assert.equal(sent.ok, true)
  assert.match(raw, /To: me@example.com/)
  assert.ok(!/^Bcc:/m.test(raw))

  const failing = { sendMail: async () => { throw new Error("535 auth failed") } }
  const bad = await transports.sendEmail(smtp, event, failing)
  assert.deepEqual([bad.ok, bad.error], [false, "535 auth failed"])
}

await testTransports()

const queue = await import("../services/notification-queue")

function memoryStore(connectors: Record<string, { enabled: boolean; rateLimitPerMinute: number }>) {
  type Row = { id: string; connectorId: string; status: string; attempts: number; nextAttemptAt: Date; event: string; error: string; sentAt: Date | null; at: Date }
  const rows: Row[] = []
  let seq = 0
  const store: import("../services/notification-queue").DeliveryStore = {
    async resetSending() { let n = 0; for (const r of rows) if (r.status === "sending") { r.status = "pending"; n++ } return n },
    async due(now, limit) {
      return rows.filter(r => r.status === "pending" && r.nextAttemptAt <= now)
        .sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, limit)
        .map(r => ({ id: r.id, connectorId: r.connectorId, attempts: r.attempts, event: r.event }))
    },
    async connector(id) { return connectors[id] ?? null },
    async sentSince(id, since) { return rows.filter(r => r.connectorId === id && r.status === "sent" && r.sentAt && r.sentAt > since).map(r => r.sentAt!) },
    async update(id, patch) { Object.assign(rows.find(r => r.id === id)!, patch) },
    async insertPending(list) { for (const l of list) rows.push({ id: `r${seq++}`, connectorId: l.connectorId, status: "pending", attempts: 0, nextAttemptAt: l.now, event: l.event, error: "", sentAt: null, at: new Date(l.now.getTime() + seq) }) },
    async oldestPending(count) { return rows.filter(r => r.status === "pending").sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, count).map(r => r.id) },
    async countPending() { return rows.filter(r => r.status === "pending").length },
    async prune() {},
  }
  return { store, rows }
}

async function testDeliveryQueue() {
  const t0 = new Date("2026-09-28T08:00:00.000Z")
  const at = (ms: number) => new Date(t0.getTime() + ms)
  const event = { type: "alert.raised" as const, severity: "warning" as const, source: "s", target: "t", message: "m", time: t0.toISOString() }

  // Pure planning.
  assert.equal(queue.planAfterAttempt(0, { ok: true }, t0).status, "sent")
  const retry = queue.planAfterAttempt(0, { ok: false, error: "x" }, t0)
  assert.deepEqual([retry.status, retry.attempts, retry.nextAttemptAt.getTime() - t0.getTime()], ["pending", 1, 2_000])
  assert.equal(queue.planAfterAttempt(1, { ok: false }, t0).nextAttemptAt.getTime() - t0.getTime(), 10_000)
  assert.equal(queue.planAfterAttempt(2, { ok: false, error: "x" }, t0).status, "failed")
  assert.equal(queue.rateLimitedUntil([at(-30_000)], 2, t0), null)
  assert.equal(queue.rateLimitedUntil([at(-30_000), at(-10_000)], 2, t0)?.getTime(), at(30_000).getTime())
  assert.equal(queue.rateLimitedUntil([at(-70_000), at(-10_000)], 2, t0), null)

  // Retries then failure, one attempt per tick.
  {
    const { store, rows } = memoryStore({ c: { enabled: true, rateLimitPerMinute: 10 } })
    await queue.enqueue(store, ["c"], event, t0)
    let calls = 0
    const deliver = async () => { calls++; return { ok: false, error: "down" } }
    await queue.runDeliveryTick(store, deliver, t0)
    await queue.runDeliveryTick(store, deliver, at(1_000)) // not due yet
    await queue.runDeliveryTick(store, deliver, at(2_000))
    await queue.runDeliveryTick(store, deliver, at(12_000))
    assert.equal(calls, 3)
    assert.deepEqual([rows[0]!.status, rows[0]!.attempts, rows[0]!.error], ["failed", 3, "down"])
  }

  // Crash recovery: a row left in "sending" is retried after restart.
  {
    const { store, rows } = memoryStore({ c: { enabled: true, rateLimitPerMinute: 10 } })
    await queue.enqueue(store, ["c"], event, t0)
    rows[0]!.status = "sending"
    assert.equal(await store.resetSending(), 1)
    await queue.runDeliveryTick(store, async () => ({ ok: true }), t0)
    assert.equal(rows[0]!.status, "sent")
  }

  // Rate limit inside a single tick: 12 rows, limit 10 -> 10 sent, 2 delayed.
  {
    const { store, rows } = memoryStore({ c: { enabled: true, rateLimitPerMinute: 10 } })
    for (let i = 0; i < 12; i++) await queue.enqueue(store, ["c"], event, t0)
    await queue.runDeliveryTick(store, async () => ({ ok: true }), t0)
    assert.equal(rows.filter(r => r.status === "sent").length, 10)
    const delayed = rows.filter(r => r.status === "pending")
    assert.equal(delayed.length, 2)
    assert.ok(delayed.every(r => r.nextAttemptAt.getTime() === at(60_000).getTime() && r.attempts === 0))
  }

  // Disabled / removed connectors fail their rows without sending.
  {
    const { store, rows } = memoryStore({ off: { enabled: false, rateLimitPerMinute: 10 } })
    await queue.enqueue(store, ["off", "gone"], event, t0)
    let calls = 0
    await queue.runDeliveryTick(store, async () => { calls++; return { ok: true } }, t0)
    assert.equal(calls, 0)
    assert.deepEqual(rows.map(r => [r.status, r.error]), [["failed", "connector disabled"], ["failed", "connector removed"]])
  }

  // Queue cap: the oldest pending rows are failed with "queue full".
  {
    const { store, rows } = memoryStore({ c: { enabled: true, rateLimitPerMinute: 10 } })
    for (let i = 0; i < queue.QUEUE_CAP + 2; i++) await queue.enqueue(store, ["c"], event, t0)
    assert.equal(await store.countPending(), queue.QUEUE_CAP)
    assert.deepEqual(rows.slice(0, 2).map(r => [r.status, r.error]), [["failed", "queue full"], ["failed", "queue full"]])
  }

  // A throwing transport counts as a failed attempt.
  {
    const { store, rows } = memoryStore({ c: { enabled: true, rateLimitPerMinute: 10 } })
    await queue.enqueue(store, ["c"], event, t0)
    await queue.runDeliveryTick(store, async () => { throw new Error("boom") }, t0)
    assert.deepEqual([rows[0]!.status, rows[0]!.error], ["pending", "boom"])
  }
}

await testDeliveryQueue()

const watch = await import("../services/update-watch")

async function testUpdateWatch() {
  const t0 = new Date("2026-09-28T08:00:00.000Z")
  const attempt = { from: "v1.57.0", target: "v1.58.0", requestedAt: t0.toISOString() }
  const later = new Date(t0.getTime() + 16 * 60_000)
  const restarted = new Date(t0.getTime() + 5 * 60_000) // backend restarted by the installer
  assert.equal(watch.evaluateUpdateAttempt(attempt, "v1.58.0", false, later, restarted).kind, "succeeded")
  assert.equal(watch.evaluateUpdateAttempt(attempt, "v1.57.0", true, later, restarted).kind, "wait")
  // Just restarted: VERSION may not be written yet.
  assert.equal(watch.evaluateUpdateAttempt(attempt, "v1.57.0", false, new Date(restarted.getTime() + 60_000), restarted).kind, "wait")
  // Never restarted (old backend still serving while the release downloads): no alarm at 16 min...
  const before = new Date(t0.getTime() - 3_600_000)
  assert.equal(watch.evaluateUpdateAttempt(attempt, "v1.57.0", false, later, before).kind, "wait")
  // ...only once the installer clearly never got as far as restarting HSI.
  assert.equal(watch.evaluateUpdateAttempt(attempt, "v1.57.0", false, new Date(t0.getTime() + 61 * 60_000), before).kind, "failed")
  const failed = watch.evaluateUpdateAttempt(attempt, "v1.57.0", false, later, restarted)
  assert.equal(failed.kind, "failed")
  if (failed.kind === "failed") {
    assert.deepEqual(
      [failed.event.type, failed.event.severity, failed.event.source, failed.event.target, failed.event.message],
      ["update.failed", "critical", "system.update", "v1.58.0", "Update to v1.58.0 failed, still running v1.57.0"],
    )
  }

  const { writeFile, access } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "hsi-update-watch-"))
  const exists = (p: string) => access(p).then(() => true, () => false)
  try {
    const events: unknown[] = []
    const dispatch = (e: unknown) => { events.push(e) }
    assert.equal(await watch.checkUpdateAttempt(dir, "v1.57.0", later, dispatch, restarted), "none")

    await writeFile(join(dir, watch.ATTEMPT_FILE), JSON.stringify(attempt))
    await writeFile(join(dir, ".pending-update"), "v1.58.0")
    assert.equal(await watch.checkUpdateAttempt(dir, "v1.57.0", later, dispatch, restarted), "wait")

    await rm(join(dir, ".pending-update"))
    assert.equal(await watch.checkUpdateAttempt(dir, "v1.57.0", later, dispatch, restarted), "failed")
    assert.equal(events.length, 1)
    assert.equal(await exists(join(dir, watch.ATTEMPT_FILE)), false)
    // Emitted once.
    assert.equal(await watch.checkUpdateAttempt(dir, "v1.57.0", later, dispatch, restarted), "none")

    await writeFile(join(dir, watch.ATTEMPT_FILE), JSON.stringify(attempt))
    assert.equal(await watch.checkUpdateAttempt(dir, "v1.58.0", later, dispatch, restarted), "succeeded")
    assert.equal(events.length, 1)

    // Half-written file: removed, no event, no throw.
    await writeFile(join(dir, watch.ATTEMPT_FILE), "{\"from\":\"v1")
    assert.equal(await watch.checkUpdateAttempt(dir, "v1.57.0", later, dispatch, restarted), "corrupt")
    assert.equal(await exists(join(dir, watch.ATTEMPT_FILE)), false)
    assert.equal(events.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await testUpdateWatch()

async function testUpdateResultNotifications() {
  const { writeFile, readFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "hsi-update-result-"))
  try {
    const events: any[] = []
    const dispatch = (e: unknown) => { events.push(e) }
    const rolledBack = { from: "v1.66.0", to: "v1.67.0", status: "rolled-back", step: "health", reason: "database check failed", at: "2026-10-22T10:00:00Z" }
    assert.equal(await watch.notifyUpdateResult(dir, null, dispatch), "none")
    assert.equal(await watch.notifyUpdateResult(dir, { ...rolledBack, status: "success", at: "2026-10-21T10:00:00Z" }, dispatch), "none")
    assert.equal(await watch.notifyUpdateResult(dir, rolledBack, dispatch), "notified")
    assert.equal(events.length, 1)
    assert.deepEqual(
      [events[0].source, events[0].severity, events[0].target],
      ["system.update", "critical", "v1.67.0"],
    )
    assert.match(events[0].message, /rolled back/)
    assert.match(events[0].message, /health/)
    assert.match(events[0].message, /database check failed/)
    // Once per result, also across restarts (the notified time is persisted).
    assert.equal(await watch.notifyUpdateResult(dir, rolledBack, dispatch), "none")
    assert.equal(events.length, 1)
    assert.match(await readFile(join(dir, watch.NOTIFIED_FILE), "utf8"), /2026-10-22T10:00:00Z/)
    // A newer result is notified again; an older one never is.
    const refused = { ...rolledBack, status: "refused", step: "verify", reason: "bad signature", at: "2026-10-23T10:00:00Z" }
    assert.equal(await watch.notifyUpdateResult(dir, refused, dispatch), "notified")
    assert.equal(events.length, 2)
    assert.match(events[1].message, /refused/)
    assert.equal(await watch.notifyUpdateResult(dir, rolledBack, dispatch), "none")
    const failedRollback = { ...rolledBack, status: "rollback-failed", at: "2026-10-24T10:00:00Z" }
    assert.equal(await watch.notifyUpdateResult(dir, failedRollback, dispatch), "notified")
    assert.match(events[2].message, /rollback failed/)
    // A rollback the administrator ran by hand is no failure to alert on; a manual
    // rollback that failed still is.
    const manual = { ...rolledBack, step: "manual", reason: "rolled back by the administrator", at: "2026-10-25T10:00:00Z" }
    assert.equal(await watch.notifyUpdateResult(dir, manual, dispatch), "none")
    assert.equal(events.length, 3)
    const manualFailed = { ...manual, status: "rollback-failed", at: "2026-10-26T10:00:00Z" }
    assert.equal(await watch.notifyUpdateResult(dir, manualFailed, dispatch), "notified")
    // A corrupt notified file does not stop the alert.
    await writeFile(join(dir, watch.NOTIFIED_FILE), "{nope")
    assert.equal(await watch.notifyUpdateResult(dir, failedRollback, dispatch), "notified")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await testUpdateResultNotifications()

async function testUpdateResultHistory() {
  const dir = await mkdtemp(join(tmpdir(), "hsi-update-history-"))
  try {
    const events: any[] = []
    const dispatch = (e: unknown) => { events.push(e) }
    // Two results written between two checks: both notified, oldest first, once each.
    const refused = { from: "v1.67.1", to: "v1.67.9", status: "refused", step: "verify", reason: "bad signature", at: "2026-10-23T05:18:42Z" }
    const rolledBack = { from: "v1.67.1", to: "v1.67.2", status: "rolled-back", step: "health", reason: "server down", at: "2026-10-23T05:21:10Z" }
    assert.equal(await watch.notifyUpdateResults(dir, [rolledBack, refused], dispatch), 2)
    assert.deepEqual(events.map(e => e.target), ["v1.67.9", "v1.67.2"])
    assert.equal(await watch.notifyUpdateResults(dir, [refused, rolledBack], dispatch), 0)
    const ok = { ...rolledBack, status: "success", step: "commit", at: "2026-10-23T06:00:00Z" }
    const manual = { ...rolledBack, step: "manual", at: "2026-10-23T06:10:00Z" }
    assert.equal(await watch.notifyUpdateResults(dir, [refused, rolledBack, ok, manual], dispatch), 0)
    assert.equal(events.length, 2)

    // A result written after the boot check is notified when the worker announces it.
    const dir2 = await mkdtemp(join(tmpdir(), "hsi-update-announce-"))
    let history: any[] = []
    let announce: () => void = () => {}
    const seen: any[] = []
    const watcher = watch.watchUpdateResults({
      dir: () => dir2,
      readStatus: async () => ({ last: history.at(-1) ?? null, current: "v1.67.1", previous: [], history }),
      dispatch: e => { seen.push(e) },
      subscribe: cb => { announce = cb },
    })
    await watcher.check()
    assert.equal(seen.length, 0)
    history = [rolledBack]
    announce()
    await watcher.idle()
    assert.equal(seen.length, 1)
    assert.equal(seen[0].target, "v1.67.2")
    // An older worker reports only last: it is still read.
    history = []
    const legacy = watch.watchUpdateResults({
      dir: () => dir2, dispatch: e => { seen.push(e) }, subscribe: () => {},
      readStatus: async () => ({ last: { ...refused, at: "2026-10-24T00:00:00Z" }, current: "v1.67.1", previous: [] }),
    })
    await legacy.check()
    assert.equal(seen.length, 2)
    await rm(dir2, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await testUpdateResultHistory()

async function testPendingUpdateIsWrittenAtomically() {
  const { writePendingUpdate } = await import("../trpc/routers/update")
  const { readFile, link, readdir, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "hsi-pending-"))
  try {
    const marker = join(dir, ".pending-update")
    // A second name for the old file: an in-place write would change it too, a
    // rename replaces the marker with a new, complete file.
    await writeFile(marker, "v1.0.0")
    await link(marker, join(dir, "witness"))
    writePendingUpdate(marker, "v1.67.0")
    assert.equal(await readFile(marker, "utf8"), "v1.67.0")
    assert.equal(await readFile(join(dir, "witness"), "utf8"), "v1.0.0", "the marker was written in place")
    assert.deepEqual((await readdir(dir)).sort(), [".pending-update", "witness"], "a temporary file was left")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await testPendingUpdateIsWrittenAtomically()

async function testHealthRoute() {
  const Fastify = (await import("fastify")).default
  const { healthRoutes } = await import("../routes/health")
  const probe = async (nats: boolean, db: boolean, from: { remoteAddress?: string; headers?: Record<string, string> } = {}) => {
    const app = Fastify()
    await app.register(healthRoutes, { nats: () => nats, db: async () => db })
    const res = await app.inject({ method: "GET", url: "/health", remoteAddress: from.remoteAddress ?? "127.0.0.1", headers: from.headers })
    await app.close()
    return { status: res.statusCode, body: res.json() }
  }
  const ok = await probe(true, true)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { status: "ok", nats: true, db: true, version: "dev" })
  const dbDown = await probe(true, false)
  assert.equal(dbDown.status, 503)
  assert.equal(dbDown.body.db, false)
  assert.equal(dbDown.body.nats, true)
  assert.equal(dbDown.body.status, "degraded")
  const natsDown = await probe(false, true)
  assert.equal(natsDown.status, 503)
  assert.equal(natsDown.body.nats, false)
  assert.equal(natsDown.body.version, "dev")
  // The version and the database state are for the update gate on loopback only;
  // other callers, and requests a local proxy forwards, see what they saw before.
  assert.deepEqual((await probe(true, true, { remoteAddress: "::1" })).body.version, "dev")
  assert.deepEqual((await probe(true, true, { remoteAddress: "::ffff:127.0.0.1" })).body.db, true)
  const remote = await probe(true, true, { remoteAddress: "192.168.1.20" })
  assert.equal(remote.status, 200)
  assert.deepEqual(remote.body, { status: "ok", nats: true })
  assert.deepEqual((await probe(true, false, { remoteAddress: "192.168.1.20" })).body, { status: "degraded", nats: true })
  assert.deepEqual((await probe(true, true, { headers: { "x-forwarded-for": "192.168.1.20" } })).body, { status: "ok", nats: true })
  assert.deepEqual((await probe(true, true, { headers: { "x-real-ip": "192.168.1.20" } })).body, { status: "ok", nats: true })
  assert.deepEqual((await probe(true, true, { headers: { forwarded: "for=192.168.1.20" } })).body, { status: "ok", nats: true })
  // A database that never answers is reported down instead of hanging the probe.
  const { checkDatabase } = await import("../routes/health")
  const started = Date.now()
  assert.equal(await checkDatabase(() => new Promise(() => {}), 50), false)
  assert.ok(Date.now() - started < 1000)
  assert.equal(await checkDatabase(async () => 1, 50), true)
  assert.equal(await checkDatabase(async () => { throw new Error("down") }, 50), false)
}

await testHealthRoute()

async function testSharedProbeAndSlowWorker() {
  const { shareProbe } = await import("../routes/health")
  let runs = 0
  let release: (v: boolean) => void = () => {}
  const probe = shareProbe(() => { runs++; return new Promise<boolean>(r => { release = r }) }, 2_000)
  const calls = Promise.all([probe(), probe(), probe()])
  release(true)
  assert.deepEqual(await calls, [true, true, true])
  assert.equal(runs, 1, "concurrent calls share one query")
  assert.equal(await probe(), true)
  assert.equal(runs, 1, "the result is cached")
  const expiring = shareProbe(async () => { runs++; return true }, 0)
  await expiring(); await expiring()
  assert.equal(runs, 3, "an expired result is probed again")

  // A worker that never answers delays update.status by the 2 s cap at most.
  let asked: number | undefined
  const never = (_s: string, _p: Record<string, unknown>, timeout?: number) => { asked = timeout; return new Promise<never>(() => {}) }
  const started = Date.now()
  assert.equal(await watch.readWorkerUpdateStatus(never as any, 50), null)
  assert.ok(Date.now() - started < 1000)
  assert.equal(asked, 50)
  const answer = { last: null, current: "v1", previous: [] }
  assert.deepEqual(await watch.readWorkerUpdateStatus((async () => answer) as any), answer)
  assert.equal(await watch.readWorkerUpdateStatus((async () => { throw new Error("down") }) as any), null)
}

await testSharedProbeAndSlowWorker()

async function testReviewFixes() {
  const key = Buffer.alloc(32, 5)

  // Live preview must not put form secrets in a GET query string (request logs).
  const { notificationsRouter } = await import("../trpc/routers/notifications")
  assert.equal((notificationsRouter as any)._def.procedures.renderPreview._def.type, "mutation")

  // URLs with credentials are rejected: fetch refuses them and echoes the URL in its error.
  assert.throws(() => conn.mergeConnectorInput({ type: "webhook", method: "POST", url: "https://u:pw@host.test/x", headers: "{}", bodyTemplate: "" }, null), /credentials/)

  // Transport errors never carry the secret URL or header values.
  const secretHook = { type: "webhook" as const, method: "POST", url: "https://hooks.test/SECRETPATH?token=abc", headers: { Authorization: "Bearer HDRSECRET" }, bodyTemplate: "{}" }
  const leaky = (async (url: string, init: any) => { throw new Error(`failed ${url} with ${init.headers.Authorization}`) }) as any
  const res = await transports.deliverResolved(secretHook, sampleLikeEvent(), { fetchImpl: leaky })
  assert.equal(res.ok, false)
  assert.ok(!res.error!.includes("SECRETPATH") && !res.error!.includes("abc") && !res.error!.includes("HDRSECRET"), res.error ?? "")

  // Masked secrets are only reused for the same destination.
  const prevHook = { type: "webhook" as const, method: "POST", url: "https://discord.com/api/webhooks/1/s", headers: { Authorization: "Bearer k" }, bodyTemplate: "{}" }
  assert.throws(() => conn.mergeConnectorInput(
    { type: "webhook", method: "POST", url: "https://evil.test/collect", headers: JSON.stringify({ Authorization: conn.SECRET_MASK }), bodyTemplate: "{}" }, prevHook), /re-enter/)
  assert.throws(() => conn.mergeConnectorInput(
    { type: "webhook", method: "POST", url: "https://evil.test/…", headers: "{}", bodyTemplate: "{}" }, prevHook), /re-enter/)
  // Same origin, new path: the masked header is kept.
  const samOrigin = conn.mergeConnectorInput(
    { type: "webhook", method: "POST", url: "https://discord.com/api/webhooks/2/t", headers: JSON.stringify({ Authorization: conn.SECRET_MASK }), bodyTemplate: "{}" }, prevHook)
  assert.equal(samOrigin.type === "webhook" && samOrigin.headers.Authorization, "Bearer k")

  const prevMail = { type: "smtp" as const, smtp: {
    host: "smtp.example.com", port: 587, security: "starttls" as const, username: "nas", password: "pw",
    from: "nas@example.com", to: ["me@example.com"], subjectTemplate: "s", bodyTemplate: "b",
  } }
  assert.throws(() => conn.mergeConnectorInput({ type: "smtp", smtp: { ...prevMail.smtp, host: "evil.test", password: "" } }, prevMail), /re-enter/)
  assert.throws(() => conn.mergeConnectorInput({ type: "smtp", smtp: { ...prevMail.smtp, username: "other", password: "" } }, prevMail), /re-enter/)
  // No authentication at all: nothing to re-enter.
  const noAuth = conn.mergeConnectorInput({ type: "smtp", smtp: { ...prevMail.smtp, host: "relay.test", username: "", password: "" } }, prevMail)
  assert.equal(noAuth.type === "smtp" && noAuth.smtp.password, "")

  // Unreadable stored secrets: an SMTP save with username and no password is refused.
  assert.throws(() => conn.mergeConnectorInput({ type: "smtp", smtp: { ...prevMail.smtp, password: "" } }, null, { unreadable: true }), (e: Error) => e.name === "SecretsError")

  // A row left in "sending" by an aborted tick (no restart) is retried on the next tick.
  {
    const { store, rows } = memoryStore({ c: { enabled: true, rateLimitPerMinute: 10 } })
    const t = new Date("2026-09-28T09:00:00.000Z")
    await queue.enqueue(store, ["c"], sampleLikeEvent(), t)
    rows[0]!.status = "sending"
    await queue.runDeliveryTick(store, async () => ({ ok: true }), t)
    assert.equal(rows[0]!.status, "sent")
  }

  void key
  function sampleLikeEvent() {
    return { type: "alert.raised" as const, severity: "warning" as const, source: "s", target: "t", message: "m", time: "2026-09-28T09:00:00.000Z" }
  }
}

await testReviewFixes()

const vg = await import("../services/volume-guard")

async function testVolumeGuard() {
  assert.equal(vg.pathUnder("/mnt/data/x", "/mnt/data"), true)
  assert.equal(vg.pathUnder("/mnt/data", "/mnt/data"), true)
  assert.equal(vg.pathUnder("/mnt/data2/x", "/mnt/data"), false)

  const holds = [{ mountPoint: "/mnt/data", status: "blocked", reason: "missing" }, { mountPoint: "/mnt/data/sub", status: "back", reason: "missing" }]
  assert.equal(vg.holdFor(holds, "/mnt/data/sub/f")?.mountPoint, "/mnt/data/sub")
  assert.equal(vg.holdFor(holds, "/mnt/data2/f"), null)
  assert.equal(vg.holdMessage(holds[0]!), "Volume /mnt/data is missing; resume it in Storage first")
  assert.equal(vg.holdMessage(holds[1]!), "Volume /mnt/data/sub is waiting for confirmation; resume it in Storage first")

  const plan = vg.planHolds(
    [{ mountPoint: "/a", state: "missing" }, { mountPoint: "/b", state: "ok" }, { mountPoint: "/c", state: "readonly" }, { mountPoint: "/d", state: "ok" }],
    [{ mountPoint: "/b", status: "blocked", reason: "missing" }, { mountPoint: "/c", status: "back", reason: "missing" }, { mountPoint: "/d", status: "back", reason: "wrong" }],
  )
  assert.deepEqual(plan.create, [{ mountPoint: "/a", reason: "missing" }])
  assert.deepEqual(plan.back, ["/b"])
  assert.deepEqual(plan.reblock, [{ mountPoint: "/c", reason: "readonly" }])
  // A hold whose volume is no longer an HSI volume (fstab entry removed) is released.
  assert.deepEqual(vg.planHolds([{ mountPoint: "/a", state: "ok" }], [{ mountPoint: "/gone", status: "blocked", reason: "missing" }]).release, ["/gone"])
  // Unmounted on purpose: blocked (nothing may write there) but no alert.
  assert.deepEqual(vg.planHolds([{ mountPoint: "/u", state: "unmounted" }], []).create, [{ mountPoint: "/u", reason: "unmounted" }])

  assert.deepEqual(vg.appsUnder([{ name: "web", sources: ["/mnt/data/www"], running: true }, { name: "db", sources: ["/srv/db"], running: true }, { name: "x", sources: ["/mnt/data2/y"], running: true }], "/mnt/data"), ["web"])
  // Only apps that are running are recorded: Resume must not start an app the admin had stopped.
  assert.deepEqual(vg.appsUnder([{ name: "on", sources: ["/mnt/data/a"], running: true }, { name: "off", sources: ["/mnt/data/b"], running: false }], "/mnt/data"), ["on"])

  const f = vg.volumeFindings([{ mountPoint: "/a", state: "missing" }, { mountPoint: "/b", state: "readonly" }, { mountPoint: "/c", state: "ok" }, { mountPoint: "/d", state: "wrong" }])
  assert.deepEqual(f.checked, ["/a", "/b", "/c", "/d"])
  assert.deepEqual(f.found.map(x => [x.target, x.severity]), [["/a", "critical"], ["/b", "warning"], ["/d", "critical"]])
  const g = vg.volumeFindings([{ mountPoint: "/u", state: "unmounted" }], ["/gone"])
  assert.deepEqual(g.found, [])
  assert.deepEqual(g.checked.sort(), ["/gone", "/u"]) // an orphaned alert is checked, so it clears
}

await testVolumeGuard()

const sp = await import("../services/storage-plan")

async function testStoragePlanAudit() {
  assert.ok(sp.PLAN_OPS.includes("format") && sp.PLAN_OPS.includes("raid.stop") && sp.PLAN_OPS.includes("storage.reapply") && sp.PLAN_OPS.includes("storage.accept") && sp.PLAN_OPS.includes("system.identity") && sp.PLAN_OPS.includes("network.ipv4") && sp.PLAN_OPS.length === 33)
  const meta = sp.planAuditMeta("format",
    [{ kind: "run", target: "/dev/sdb1", summary: "Create ext4", command: ["mkfs.ext4", "-F", "/dev/sdb1"], destructive: true },
     { kind: "update", target: "/etc/mdadm/mdadm.conf", summary: "Add ARRAY", diff: "+ARRAY" }],
    [{ status: "done" }, { status: "failed", error: "boom" }])
  assert.deepEqual(meta, {
    op: "format",
    steps: [
      { kind: "run", target: "/dev/sdb1", summary: "Create ext4", command: "mkfs.ext4 -F /dev/sdb1", destructive: true, status: "done" },
      { kind: "update", target: "/etc/mdadm/mdadm.conf", summary: "Add ARRAY", diff: "+ARRAY", status: "failed", error: "boom" },
    ],
  })
}

await testStoragePlanAudit()

const trpcIndex = await import("../trpc/index")

async function testAuditTargetForPlans() {
  assert.equal(trpcIndex.extractTarget({ op: "format", input: { device: "sdb1", fstype: "ext4" }, fingerprint: "x" }), "sdb1")
  assert.equal(trpcIndex.extractTarget({ op: "umount", input: { mountpoint: "/mnt/data" } }), "/mnt/data")
  assert.equal(trpcIndex.extractTarget({ path: "/a" }), "/a")
}

await testAuditTargetForPlans()

const ap = await import("../services/app-plan")

async function testAppPlanEngine() {
  const yaml = "services:\n  db:\n    environment:\n      DB_PASSWORD: hunter2\n      TZ: Europe/Paris\n  app:\n    environment:\n      - API_TOKEN=abc\n      - LANG=C\n"
  const masked = ap.maskSecrets(yaml)
  assert.ok(!masked.includes("hunter2") && !masked.includes("abc"))
  assert.match(masked, /DB_PASSWORD: ••••••/)
  assert.match(masked, /- API_TOKEN=••••••/)
  assert.match(masked, /TZ: Europe\/Paris/)
  assert.match(masked, /- LANG=C/)

  const diff = ap.unifiedDiff("/opt/containers/x/compose.yaml", "a\nb\n", "a\nB\n")
  assert.match(diff, /-b\n\+B\n/)
  assert.equal(ap.unifiedDiff("/f", "same\n", "same\n"), "")

  const plan = (content: string) => ({
    op: "app.save" as const,
    steps: [{ kind: "update", target: "/opt/containers/x/compose.yaml", summary: "Update", diff: "d", run: async () => ({}) }],
    observed: { content },
  })
  const fp = ap.appFingerprint(plan("v1"), { name: "x", b: 1, a: 2 })
  assert.equal(fp, ap.appFingerprint(plan("v1"), { a: 2, name: "x", b: 1 }))
  assert.notEqual(fp, ap.appFingerprint(plan("v2"), { name: "x", b: 1, a: 2 }))

  const order: string[] = []
  const run = await ap.executeAppPlan({
    op: "app.install",
    steps: [
      { kind: "create", target: "/d", summary: "dir", run: async () => { order.push("dir"); return {} } },
      { kind: "run", target: "x", summary: "up", background: true, run: async () => { order.push("up"); return { jobId: "job-1" } } },
    ],
    observed: {},
  })
  assert.equal(run.ok, true)
  assert.deepEqual(run.results.map(r => r.status), ["done", "started"])
  assert.equal(run.results[1]!.jobId, "job-1")
  const failed = await ap.executeAppPlan({
    op: "app.install",
    steps: [
      { kind: "create", target: "/d", summary: "dir", run: async () => { throw new Error("nope") } },
      { kind: "run", target: "x", summary: "up", run: async () => ({}) },
    ],
    observed: {},
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, "nope")
  assert.deepEqual(failed.results.map(r => r.status), ["failed", "not-run"])
}

await testAppPlanEngine()

async function testAppPlanBuilders() {
  const calls: string[] = []
  let building = true
  const effect = (name: string) => async (...args: unknown[]) => {
    if (building) throw new Error(`${name} called while building a plan`)
    calls.push(`${name}:${String(args[0])}`)
    return name === "createPlace" ? "place-new" : name === "publishJob" ? "job-7" : undefined
  }
  const stacks: Record<string, string> = {
    web: "services:\n  web:\n    image: nginx:1.27\n",
    // A database in a named volume and a folder in a Place (#26).
    blog: "services:\n  blog:\n    image: ghost:5\n    volumes: [/mnt/media/blog:/content]\n  db:\n    image: mariadb:11\n    volumes: [db:/var/lib/mysql]\nvolumes:\n  db:\n",
  }
  let secretN = 0
  const manifest = {
    id: "demo", name: "Demo", image: "demo/demo:1.0", webUiPort: 80, restartPolicy: "unless-stopped",
    ports: [{ container: 80, hostDefault: 8080, protocol: "tcp" }],
    env: [{ key: "ADMIN_PASSWORD", secret: true, required: false }, { key: "TZ", default: "UTC" }],
    volumes: [{ target: "/data", readOnlyDefault: false }],
  }
  const deps: import("../services/app-plan").AppPlanDeps = {
    stackPath: (n) => `/opt/containers/${n}/compose.yaml`,
    readStack: async (n) => stacks[n] ?? null,
    readPrevious: async () => null,
    appStatus: async () => "running",
    findPlace: async (id) => id === "p1" ? { id: "p1", name: "Media", path: "/mnt/media" } : null,
    placeAtPath: async (path) => path === "/mnt/taken",
    catalog: (id) => (id === "demo" ? manifest as any : undefined),
    secret: () => `generated-${secretN++}`,
    effects: {
      writeStack: effect("writeStack") as any, removeStackDir: effect("removeStackDir") as any, mkdirp: effect("mkdirp") as any,
      createPlace: effect("createPlace") as any, validate: effect("validate") as any, publishJob: effect("publishJob") as any,
      writePrevious: effect("writePrevious") as any, removePrevious: effect("removePrevious") as any,
    },
  }

  // save (update): masked diff against the current file.
  const upd = await ap.buildAppPlan("app.save", { name: "web", raw: "services:\n  web:\n    image: nginx:1.28\n    environment:\n      DB_PASSWORD: s3cret\n" }, deps)
  assert.equal(upd.steps[0]!.kind, "update")
  assert.match(upd.steps[0]!.diff!, /\+ {4}image: nginx:1\.28/)
  assert.ok(!JSON.stringify(ap.publicSteps(upd)).includes("s3cret"))
  await assert.rejects(ap.buildAppPlan("app.save", { name: "web", raw: "not: [yaml" }, deps))
  await assert.rejects(ap.buildAppPlan("app.save", { name: "nope", raw: "services:\n  a:\n    image: x:1\n" }, deps), /not found/i)
  await assert.rejects(ap.buildAppPlan("app.save", { name: "web", create: true, raw: "services:\n  a:\n    image: x:1\n" }, deps), /already exists/)

  // apply: one background compose up, validate then publish.
  const apply = await ap.buildAppPlan("app.apply", { name: "web" }, deps)
  assert.deepEqual(apply.steps[0]!.command, ["docker", "compose", "-f", "/opt/containers/web/compose.yaml", "up", "-d"])
  assert.equal(apply.steps[0]!.background, true)
  assert.match(apply.steps[0]!.summary, /nginx:1\.27/)

  // remove: two steps, one job.
  const rm = await ap.buildAppPlan("app.remove", { name: "web" }, deps)
  assert.deepEqual(rm.steps.map(s => s.kind), ["run", "delete"])
  assert.equal(rm.steps[1]!.destructive, true)

  // remove keeps the data by default and says where it stays; deleteData
  // deletes the Docker volumes, never the folders in Places (#26).
  const keep = await ap.buildAppPlan("app.remove", { name: "blog" }, deps)
  assert.deepEqual(keep.steps.map(s => s.kind), ["run", "delete", "info", "info"])
  assert.ok(!keep.steps[0]!.command!.includes("--volumes"))
  assert.match(keep.steps[2]!.summary, /Keep its Docker volumes blog_db/)
  assert.match(keep.steps[3]!.summary, /Keep its folders \/mnt\/media\/blog/)
  const wipe = await ap.buildAppPlan("app.remove", { name: "blog", deleteData: true }, deps)
  assert.deepEqual(wipe.steps.map(s => s.kind), ["run", "delete", "delete", "info"])
  assert.deepEqual(wipe.steps[0]!.command!.slice(-2), ["down", "--volumes"])
  assert.equal(wipe.steps[2]!.destructive, true)
  assert.match(wipe.steps[2]!.summary, /blog_db/)
  assert.notEqual(ap.appFingerprint(keep, { name: "blog" }), ap.appFingerprint(wipe, { name: "blog", deleteData: true }), "the choice changes the plan")

  // install: new Place, compose file with a generated secret (masked), up.
  const inst = { id: "demo", name: "demo1", ports: [], env: [], volumes: [{ target: "/data", source: { kind: "newPlace", name: "Demo data", path: "/srv/demo" } }] }
  const p1 = await ap.buildAppPlan("app.install", inst, deps)
  const p2 = await ap.buildAppPlan("app.install", inst, deps)
  assert.deepEqual(p1.steps.map(s => s.kind), ["create", "create", "create", "run"])
  assert.ok(!JSON.stringify(ap.publicSteps(p1)).includes("generated-"))
  assert.equal(ap.appFingerprint(p1, inst), ap.appFingerprint(p2, inst), "a random secret must not make the plan stale")
  await assert.rejects(ap.buildAppPlan("app.install", { ...inst, volumes: [{ target: "/data", source: { kind: "newPlace", name: "x", path: "/mnt/taken" } }] }, deps), /Place already exists/)

  // The address the web port is reached at, behind the user's proxy (#26):
  // recorded in x-hsi for the Open link, without changing the published port.
  const addressed = await ap.buildAppPlan("app.install", { ...inst, name: "demo2", ports: [{ container: 80, host: 8081, domain: "Demo.Example.com", tls: true }] }, deps)
  const file = addressed.steps.find(s => s.target.endsWith("demo2/compose.yaml"))!.diff!
  assert.match(file, /8081:80/)
  assert.match(file, /domain: demo\.example\.com/)
  assert.match(file, /tls: true/)
  await assert.rejects(ap.buildAppPlan("app.install", { ...inst, name: "demo3", ports: [{ container: 80, host: 8081, domain: "https://x.com/" }] }, deps), /host name/)

  building = false
  const res = await ap.executeAppPlan(p1)
  assert.equal(res.ok, true)
  assert.deepEqual(calls, ["mkdirp:/srv/demo", "createPlace:Demo data", "writeStack:demo1", "validate:demo1", "publishJob:container.composeUp"])
  assert.equal(res.results[3]!.jobId, "job-7")

  // A failed validation removes the stack directory; the Place stays.
  calls.length = 0
  deps.effects.validate = async () => { throw new Error("invalid compose") }
  const p3 = await ap.buildAppPlan("app.install", { ...inst, name: "demo2" }, { ...deps, effects: { ...deps.effects } })
  const failed = await ap.executeAppPlan(p3)
  assert.equal(failed.ok, false)
  assert.ok(calls.includes("removeStackDir:demo2") && calls.includes("createPlace:Demo data"))
}

await testAppPlanBuilders()

// Review fixes (#36 apps): masking must cover values spanning several lines,
// flag a changed secret in a diff, and honour the manifest's secret keys.
{
  const ap = await import("../services/app-plan")
  const folded = "services:\n  web:\n    environment:\n      DB_PASSWORD: correct horse\n        battery staple\n      API_KEY: |-\n        line1\n        line2\n      TZ: Europe/Paris\n"
  const m = ap.maskSecrets(folded)
  for (const leak of ["battery", "line1", "line2", "correct"]) assert.ok(!m.includes(leak), `continuation lines must be masked: ${leak}`)
  assert.ok(m.includes("TZ: Europe/Paris"), "non-secret values stay visible")
  assert.ok(!ap.maskSecrets('      "DB_PASSWORD": hunter2\n').includes("hunter2"), "quoted keys are masked")

  const before = "services:\n  web:\n    environment:\n      DB_PASSWORD: old\n"
  const after  = "services:\n  web:\n    environment:\n      DB_PASSWORD: new\n"
  const d = ap.maskedDiff("/x/compose.yaml", before, after)
  assert.ok(d.includes("(changed)") && !d.includes("new") && !d.includes("old"), `a changed secret must show as changed, masked: ${d}`)
  assert.equal(ap.maskedDiff("/x/compose.yaml", before, before), "", "an unchanged file has no diff")

  assert.ok(!ap.maskSecrets("      APP_SALT: s3cr3t\n", ["APP_SALT"]).includes("s3cr3t"), "manifest secret keys are masked")
  const { CATALOG } = await import("@app/app-catalog")
  for (const mf of CATALOG) for (const e of mf.env) if (e.secret) {
    assert.ok(!ap.maskSecrets(`      ${e.key}: v4lue\n`, ap.manifestSecretKeys(mf)).includes("v4lue"), `${mf.id}: ${e.key} must be masked`)
  }
}

// The audit entry of apps.plan/apply must not carry the secrets of a raw
// compose file (form env entries are redacted by the audit middleware).
{
  const ap = await import("../services/app-plan")
  const masked = ap.appAuditInput({ op: "app.save", input: { name: "web", raw: "services:\n  web:\n    environment:\n      DB_PASSWORD: hunter2\n" }, fingerprint: "f" }) as any
  assert.ok(!JSON.stringify(masked).includes("hunter2"), "raw compose secrets must be masked in the audit input")
  assert.equal(masked.input.name, "web")
  assert.equal(masked.fingerprint, "f")
}


async function testSharePlans() {
  const sp = await import("../services/sharing-plan")
  const row = (id: string, over: Partial<import("../services/sharing-plan").ShareRow> = {}) =>
    ({ id, placeId: `p-${id}`, smbName: null, readOnly: false, guestOk: false, enabled: true, place: { name: id, path: `/srv/${id}` }, ...over })
  const rows = [row("a"), row("b", { enabled: false })]

  // Overlay: nothing written, the change is visible.
  assert.deepEqual(sp.overlayShares(rows, { kind: "create", row: row("c") }).map(r => r.id), ["a", "b", "c"])
  assert.equal(sp.overlayShares(rows, { kind: "update", id: "b", patch: { enabled: true } }).find(r => r.id === "b")!.enabled, true)
  assert.equal(sp.overlayShares(rows, { kind: "update", id: "a", patch: { enabled: false } }).find(r => r.id === "a")!.enabled, false)
  assert.deepEqual(sp.overlayShares(rows, { kind: "remove", id: "a" }).map(r => r.id), ["b"])
  assert.equal(rows.length, 2, "overlay must not mutate its input")

  const plan = { steps: [{ kind: "run", target: "smbd", summary: "reload" }], results: [{ status: "done" }] }
  let commits = 0
  const deps = (over: Partial<import("../services/sharing-plan").SharePlanDeps> = {}) => ({
    smbdInstalled: async () => true,
    defs: async () => [],
    worker: async (subject: string) => (subject === "root.plan.preview" ? { steps: plan.steps, fingerprint: "f1" } : { ok: true, ...plan }) as any,
    commit: async () => { commits++ },
    serialize: <T>(fn: () => Promise<T>) => fn(),
    resync: async () => {},
    ...over,
  })

  // Preview writes nothing.
  const pv = await sp.previewShareChange("share.create", "media", deps())
  assert.equal(pv.fingerprint, "f1")
  assert.equal(commits, 0, "preview must not write the DB")

  // Apply commits only after a successful plan.
  await sp.applyShareChange("share.create", "media", "f1", deps())
  assert.equal(commits, 1)
  const failed = await sp.applyShareChange("share.update", "media", "f1", deps({
    worker: async () => ({ ok: false, error: "reload smbd failed", steps: plan.steps, results: [{ status: "failed", error: "x" }] }) as any,
  }))
  assert.equal(failed.ok, false)
  assert.equal(commits, 1, "a failed plan must leave the DB unchanged")

  // Stale plan: CONFLICT.
  await assert.rejects(sp.applyShareChange("share.create", "media", "f1", deps({
    worker: async () => { throw Object.assign(new Error("changed"), { code: "ESTALE" }) },
  })), (e: any) => e.code === "CONFLICT")

  // Samba absent: create refused, remove only deletes the record.
  await assert.rejects(sp.previewShareChange("share.create", "media", deps({ smbdInstalled: async () => false })),
    (e: any) => e.code === "PRECONDITION_FAILED" && /apt install samba/.test(e.message))
  const nr = await sp.previewShareChange("share.remove", "media", deps({ smbdInstalled: async () => false }))
  assert.equal(nr.fingerprint, sp.NO_SAMBA_FINGERPRINT)
  assert.match(nr.steps[0]!.summary, /Samba is not installed/)
  const nra = await sp.applyShareChange("share.remove", "media", sp.NO_SAMBA_FINGERPRINT, deps({ smbdInstalled: async () => false }))
  assert.equal(nra.ok, true)
  assert.equal(commits, 2)
}
await testSharePlans()

// Review fixes: applying a share plan and automatic resyncs are serialized,
// and a failed apply brings Samba back to what the database says.
{
  const sp = await import("../services/sharing-plan")
  const { withShareLock } = await import("../services/sharing.service")
  const order: string[] = []
  await Promise.all([
    withShareLock(async () => { order.push("a1"); await new Promise(r => setTimeout(r, 20)); order.push("a2") }),
    withShareLock(async () => { order.push("b1"); order.push("b2") }),
  ])
  assert.deepEqual(order, ["a1", "a2", "b1", "b2"], "share syncs must not interleave")

  let inLock = false, resyncs = 0
  const base = {
    smbdInstalled: async () => true,
    defs: async () => { assert.ok(inLock, "defs must be read under the lock"); return [] },
    worker: async () => { assert.ok(inLock, "the plan must run under the lock"); return { ok: true, steps: [], results: [] } as any },
    commit: async () => { assert.ok(inLock, "the DB write must happen under the lock") },
    serialize: async <T>(fn: () => Promise<T>) => { inLock = true; try { return await fn() } finally { inLock = false } },
    resync: async () => { assert.ok(!inLock, "resync runs after the lock"); resyncs++ },
  }
  await sp.applyShareChange("share.remove", "media", "f1", base)
  assert.equal(resyncs, 0)
  await sp.applyShareChange("share.remove", "media", "f1", { ...base, worker: async () => ({ ok: false, steps: [], results: [] }) as any })
  assert.equal(resyncs, 1, "a failed plan resyncs Samba to the database")
  await assert.rejects(sp.applyShareChange("share.create", "media", "f1", { ...base, commit: async () => { throw new Error("unique") } }))
  assert.equal(resyncs, 2, "a failed DB write resyncs Samba to the database")
}

// Plans name what they changed in the audit log, not an opaque id.
{
  const { auditTarget } = await import("../trpc/index")
  assert.equal(auditTarget({ op: "share.update", input: { id: "ck1" } }, { target: "media" }), "media")
  assert.equal(auditTarget({ op: "share.update", input: { id: "ck1" } }, {}), "ck1")
}

{
  const up = await import("../services/user-plan")
  const calls: string[] = []
  let inLock = false
  const smbStep = { kind: "update", target: "/etc/nasui/samba/smb.conf", summary: "Update" }
  const deps = (over: Record<string, unknown> = {}): any => ({
    smbdInstalled: async () => true,
    shareDefs: async () => [],
    currentShareDefs: async () => [{ validUsers: ["alice"] }],
    serialize: async <T>(fn: () => Promise<T>) => { inLock = true; try { return await fn() } finally { inLock = false } },
    resync: async () => { calls.push("resync") },
    commit: async () => { calls.push(`commit${inLock ? ":locked" : ""}`) },
    worker: async (subject: string, payload: any) => {
      calls.push(`${subject}:${payload.op}`)
      if (subject === "root.plan.preview") {
        if (payload.op === "smb.sync") return { steps: [smbStep, { kind: "run", target: "smbd", summary: "reload" }], fingerprint: "s1" }
        if (payload.op === "group.leave") return { steps: [], fingerprint: "g1" }
        return { steps: [{ kind: "run", target: "alice", summary: "useradd" }], fingerprint: "u1" }
      }
      return { ok: true, steps: [], results: [{ status: "done" }] }
    },
    ...over,
  })
  const input = { username: "alice", password: "pw123456", samba: true }

  const pc = await up.previewUserCreate(input, deps())
  assert.equal(pc.steps.at(-1)!.summary, "Create the HSI user alice")
  assert.ok(!calls.some(c => c.startsWith("commit")), "preview writes nothing")

  calls.length = 0
  const failed = await up.applyUserCreate(input, "u1", deps({ worker: async () => ({ ok: false, error: "useradd failed", steps: [], results: [{ status: "failed" }] }) }))
  assert.equal(failed.ok, false)
  assert.ok(!calls.includes("commit"), "a failed useradd creates no HSI user")
  const ok = await up.applyUserCreate(input, "u1", deps())
  assert.equal(ok.ok, true)
  assert.equal(ok.results.at(-1)!.status, "done")

  // Delete: smb.conf shown when it changes, fingerprint combined, commit under the lock.
  const pd = await up.previewUserDelete("alice", deps())
  assert.deepEqual(pd.steps.map(s => s.kind), ["update", "run", "delete"])
  assert.match(pd.steps.at(-1)!.summary, /stay on the server/)
  calls.length = 0
  const d = await up.applyUserDelete("alice", pd.fingerprint, deps())
  assert.equal(d.ok, true)
  assert.ok(calls.includes("commit:locked"), "the delete commits under the share lock")
  await assert.rejects(up.applyUserDelete("alice", "stale", deps()), (e: any) => e.code === "CONFLICT")

  // No share access: no smb.conf step and no reload.
  const quiet = await up.previewUserDelete("alice", deps({
    currentShareDefs: async () => [],
    worker: async (subject: string, payload: any) =>
      payload.op === "smb.sync" ? { steps: [{ kind: "run", target: "smbd", summary: "reload" }], fingerprint: "s0" } : { steps: [], fingerprint: "g0" },
  }))
  assert.deepEqual(quiet.steps.map(s => s.kind), ["delete"])

  // No share access, but smb.conf out of date: the user's delete does not
  // reconcile unrelated drift (no smb.conf step, no smbd reload).
  const drift = await up.previewUserDelete("alice", deps({ currentShareDefs: async () => [] }))
  assert.deepEqual(drift.steps.map(s => s.kind), ["delete"], "only shares naming the user bring smb.conf into the plan")

  // group.leave failing with an exception after smb.conf was written resyncs.
  calls.length = 0
  const baseWorker = deps().worker
  await assert.rejects(up.applyUserDelete("alice", pd.fingerprint, deps({
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.apply" && payload.op === "group.leave") throw Object.assign(new Error("changed"), { code: "ESTALE" })
      return baseWorker(subject, payload)
    },
  })))
  assert.ok(calls.includes("resync"), "a worker error after smb.conf was written resyncs")

  // A failed DB delete after smb.conf was written resyncs.
  calls.length = 0
  const failedDelete = await up.applyUserDelete("alice", pd.fingerprint, deps({ commit: async () => { throw new Error("db") } }))
  assert.equal(failedDelete.ok, false, "a failed database delete is reported with the steps that ran")
  assert.equal(failedDelete.results.at(-1)!.status, "failed")
  assert.ok(calls.includes("resync"))
}

{
  const { dropUserFromDefs } = await import("../services/sharing.service")
  const defs = [{ name: "m", path: "/m", readOnly: false, guestOk: false, validUsers: ["alice", "bob"], writeUsers: ["alice"], unavailable: false }]
  assert.deepEqual(dropUserFromDefs(defs, "alice")[0], { ...defs[0], validUsers: ["bob"], writeUsers: [] })
}

// The password of a planned user creation never reaches the audit log.
{
  const { redactForAudit } = await import("../trpc/index")
  const logged = JSON.stringify(redactForAudit({ op: "user.create", input: { username: "alice", password: "pw123456" }, fingerprint: "f" }))
  assert.ok(!logged.includes("pw123456") && logged.includes("alice"))
}

// Disk labels (#32): trimmed, bounded, no control characters; empty removes.
{
  const { normalizeDiskLabel } = await import("../services/disk-labels")
  assert.equal(normalizeDiskLabel("  bay 3, top "), "bay 3, top")
  assert.equal(normalizeDiskLabel("   "), null)
  assert.throws(() => normalizeDiskLabel("x".repeat(41)), /40 characters/)
  assert.throws(() => normalizeDiskLabel("bay\n3"), /control characters/)
}

// Volumes (#40)
{
  const { buildVolumes } = await import("../services/volumes")
  const dev = (o: any) => ({ fstype: "", mountpoint: "", uuid: "", size: 4e12, model: "", isSystem: false, usageTotal: 0, usageUsed: 0, usageFree: 0, children: [], ...o })
  const lvNode = dev({ name: "data-data", type: "lvm", fstype: "ext4", uuid: "U-LV", mountpoint: "/srv/data", usageTotal: 4e12, usageUsed: 3.8e12, usageFree: 2e11 })
  const md0 = dev({ name: "md0", type: "raid1", fstype: "LVM2_member", usage: "lvm-pv", owner: "data", children: [lvNode] })
  const devices = [
    dev({ name: "sda", type: "disk", isSystem: true, model: "SSD", children: [dev({ name: "sda1", type: "part", isSystem: true, fstype: "ext4", mountpoint: "/", uuid: "U-ROOT", usageTotal: 5e11, usageFree: 2e11 }), dev({ name: "sda2", type: "part", isSystem: true, fstype: "vfat", mountpoint: "/boot/efi", uuid: "U-EFI" })] }),
    dev({ name: "sdb", type: "disk", model: "WDC", serial: "WD-1", children: [dev({ name: "sdb1", type: "part", fstype: "linux_raid_member", usage: "raid-member", owner: "md0", children: [md0] })] }),
    dev({ name: "sdc", type: "disk", model: "WDC", serial: "WD-2", children: [dev({ name: "sdc1", type: "part", fstype: "linux_raid_member", usage: "raid-member", owner: "md0", children: [md0] })] }),
    dev({ name: "sdd", type: "disk", model: "Toshiba", serial: "T-1", fstype: "xfs", uuid: "U-SCR", label: "scratch", mountpoint: "", usage: "filesystem" }),
    dev({ name: "sde", type: "disk", model: "Seagate", serial: "S-1", usage: "free" }),
  ]
  const input = {
    devices,
    raids: [{ name: "md0", level: "raid1", state: "active", devices: ["sdb1", "sdc1"], active: 1, total: 2, resyncPercent: 42, syncAction: "recovery" }],
    lvm: { pvs: [{ name: "/dev/md0", vgName: "data", size: 4e12, free: 0 }], vgs: [{ name: "data", size: 4e12, free: 0, pvCount: 1, lvCount: 1 }], lvs: [{ name: "data", vgName: "data", size: 4e12, path: "/dev/data/data" }] },
    guard: [{ mountPoint: "/srv/media", uuid: "U-GONE", state: "missing" as const, strayFiles: false }],
    holds: [],
    places: [{ id: "p1", name: "Photos", path: "/srv/data/photos" }, { id: "p2", name: "Root", path: "/srv" }],
    shares: [{ placeId: "p1", name: "photos" }],
    apps: [{ name: "immich", sources: ["/srv/data/photos"] }],
  }
  const o = buildVolumes(input as any)

  // The mirrored LVM volume: once, full stack, both disks, issues.
  const data = o.volumes.find(v => v.id === "U-LV")!
  assert.equal(data.name, "data", "LV name when there is no label")
  assert.equal(data.state, "mounted")
  assert.equal(data.redundancy, "raid1")
  assert.equal(data.tolerates, 1)
  assert.deepEqual(data.stack.map(s => s.kind), ["filesystem", "lv", "vg", "array", "partition", "partition", "disk", "disk"])
  assert.deepEqual(data.disks.map(d => d.name), ["sdb", "sdc"])
  assert.deepEqual(data.issues.map(i => i.kind).sort(), ["degraded", "nearly-full", "rebuilding"])
  assert.deepEqual(data.usedBy, { places: [{ id: "p1", name: "Photos" }], shares: ["photos"], apps: ["immich"] })
  assert.equal(o.volumes.filter(v => v.id === "U-LV").length, 1, "an array repeated under each member is one volume")

  // A member being rebuilt onto is not missing: a new RAID 5 builds its
  // parity that way ([3/2] with the third disk in recovery).
  const issuesWith = (r: any) => buildVolumes({ ...input, raids: [{ ...input.raids[0], ...r }] } as any).volumes.find(v => v.id === "U-LV")!.issues
  const building = issuesWith({ level: "raid5", active: 2, total: 3, members: [{ name: "sdb1", role: "active" }, { name: "sdc1", role: "active" }, { name: "sdd1", role: "active" }] })
  assert.deepEqual(building.filter(i => i.kind !== "nearly-full").map(i => i.text), ["md0 is rebuilding (42%)"])
  // The worker names the disk being rebuilt onto: present, not missing.
  const named = issuesWith({ level: "raid1", active: 1, total: 2, members: [{ name: "sdb1", role: "active" }, { name: "sdc1", role: "rebuilding" }] })
  assert.ok(!named.some(i => i.kind === "degraded"), "a rebuilding member is not missing")
  // One rebuilding, one really gone.
  const oneGone = issuesWith({ level: "raid6", active: 2, total: 4, members: [{ name: "sdb1", role: "active" }, { name: "sdc1", role: "active" }, { name: "sdd1", role: "active" }, { name: "sde1", role: "faulty" }] })
  assert.ok(oneGone.some(i => i.text === "md0 is missing 1 of 4 disks"))

  // Whole-disk filesystem, not mounted, named by its label.
  const scr = o.volumes.find(v => v.id === "U-SCR")!
  assert.equal(scr.name, "scratch")
  assert.equal(scr.state, "not-mounted")
  assert.equal(scr.redundancy, "none")
  assert.equal(scr.space, undefined)

  // Missing #3 volume, first in the list.
  assert.equal(o.volumes[0]!.state, "missing")
  assert.equal(o.volumes[0]!.mountPoint, "/srv/media")
  assert.equal(o.volumes[0]!.name, "media")

  // System disk excluded, summarised; free disks listed.
  assert.ok(!o.volumes.some(v => v.mountPoint === "/" || v.mountPoint === "/boot/efi"))
  assert.equal(o.system?.free, 2e11)
  assert.deepEqual(o.freeDisks.map(d => d.name), ["sde"])

  // A Place on /srv (no volume) attaches to nothing; nested places go to the most specific volume.
  assert.ok(!o.volumes.some(v => v.usedBy.places.some(p => p.id === "p2")))

  // No RAID and no LVM, as in an LXC container: no crash, no volume.
  const bare = buildVolumes({ ...input, devices: [], raids: [], lvm: { pvs: [], vgs: [], lvs: [] }, guard: [] } as any)
  assert.deepEqual(bare.volumes, [], "no devices: no volume")
}

// A VG spanning a mirror and a plain partition has no redundancy.
{
  const { buildVolumes } = await import("../services/volumes")
  const dev = (o: any) => ({ fstype: "", mountpoint: "", uuid: "", size: 1e12, model: "", isSystem: false, usageTotal: 0, usageUsed: 0, usageFree: 0, children: [], ...o })
  const lv = dev({ name: "big-vol", type: "lvm", fstype: "ext4", uuid: "U-BIG", mountpoint: "/srv/big", usageTotal: 2e12, usageUsed: 1e12, usageFree: 1e12 })
  const md1 = dev({ name: "md1", type: "raid1", fstype: "LVM2_member", usage: "lvm-pv", owner: "big", children: [lv] })
  const o = buildVolumes({
    devices: [
      dev({ name: "sdb", type: "disk", children: [dev({ name: "sdb1", type: "part", fstype: "linux_raid_member", usage: "raid-member", owner: "md1", children: [md1] })] }),
      dev({ name: "sdc", type: "disk", children: [dev({ name: "sdc1", type: "part", fstype: "linux_raid_member", usage: "raid-member", owner: "md1", children: [md1] })] }),
      dev({ name: "sdd", type: "disk", children: [dev({ name: "sdd1", type: "part", fstype: "LVM2_member", usage: "lvm-pv", owner: "big", children: [lv] })] }),
    ],
    raids: [{ name: "md1", level: "raid1", state: "active", devices: ["sdb1", "sdc1"], active: 2, total: 2 }],
    lvm: { pvs: [{ name: "/dev/md1", vgName: "big", size: 1e12, free: 0 }, { name: "/dev/sdd1", vgName: "big", size: 1e12, free: 0 }], vgs: [{ name: "big", size: 2e12, free: 0, pvCount: 2, lvCount: 1 }], lvs: [{ name: "vol", vgName: "big", size: 2e12, path: "/dev/big/vol" }] },
    guard: [], holds: [], places: [], shares: [], apps: [],
  } as any)
  assert.equal(o.volumes.length, 1)
  const v = o.volumes[0]!
  assert.equal(v.name, "vol")
  assert.equal(v.redundancy, "none", "a PV outside the mirror removes the redundancy")
  assert.equal(v.tolerates, 0)
  assert.deepEqual(v.disks.map(d => d.name), ["sdb", "sdc", "sdd"])
  assert.deepEqual(v.issues, [])
}

// Volumes review fixes: only real data filesystems, unique ids, holds waiting
// for Resume, system mounts not flagged by the worker, empty devices.
{
  const { buildVolumes } = await import("../services/volumes")
  const dev = (o: any) => ({ fstype: "", mountpoint: "", uuid: "", size: 1e12, model: "", isSystem: false, usageTotal: 0, usageUsed: 0, usageFree: 0, children: [], ...o })
  const o = buildVolumes({
    devices: [
      dev({ name: "loop0", type: "loop", fstype: "squashfs", mountpoint: "/snap/core/1", uuid: "", usageTotal: 1e8, usageUsed: 1e8, usageFree: 0 }),
      dev({ name: "mmcblk0", type: "disk", children: [
        dev({ name: "mmcblk0p1", type: "part", fstype: "vfat", mountpoint: "/boot/firmware", uuid: "U-FW" }),
        dev({ name: "mmcblk0p2", type: "part", fstype: "ext4", mountpoint: "/", uuid: "U-ROOT", usageTotal: 3e10, usageFree: 1e10 }),
      ] }),
      dev({ name: "sdb", type: "disk", children: [dev({ name: "sdb1", type: "part", fstype: "crypto_LUKS", uuid: "U-LUKS" })] }),
      dev({ name: "sdc", type: "disk", fstype: "btrfs", uuid: "U-BTR", mountpoint: "/srv/pool", usageTotal: 2e12, usageUsed: 1e11, usageFree: 1.9e12 }),
      dev({ name: "sdd", type: "disk", fstype: "btrfs", uuid: "U-BTR" }),
      dev({ name: "sde", type: "disk", fstype: "ext4", uuid: "U-BACK", mountpoint: "/srv/back", usageTotal: 1e12, usageUsed: 1e11, usageFree: 9e11 }),
      dev({ name: "sdf", type: "disk", size: 0, usage: "free" }),
      dev({ name: "sdg", type: "disk", usage: "free" }),
    ],
    raids: [], lvm: { pvs: [], vgs: [], lvs: [] },
    guard: [], holds: [{ mountPoint: "/srv/back", reason: "The volume came back", status: "back" }],
    places: [], shares: [], apps: [],
  } as any)
  const mounts = o.volumes.map(v => v.mountPoint)
  assert.ok(!mounts.includes("/snap/core/1"), "snap loop devices are not volumes")
  assert.ok(!mounts.includes("/") && !mounts.includes("/boot/firmware"), "system mounts are not volumes even when not flagged")
  assert.ok(!o.volumes.some(v => v.fstype === "crypto_LUKS"), "a LUKS container is not a mountable volume")
  assert.equal(new Set(o.volumes.map(v => v.id)).size, o.volumes.length, "volume ids are unique")
  assert.equal(o.system?.free, 1e10)
  const back = o.volumes.find(v => v.mountPoint === "/srv/back")!
  assert.ok(back.issues.some(i => i.kind === "blocked"), "a hold waiting for Resume is an issue")
  assert.deepEqual(o.freeDisks.map(d => d.name), ["sdg"], "an empty device is not a free disk")
}

// Storage activity (#40): audit rows of an object, with their plan steps.
{
  const { activityEntries } = await import("../services/storage-activity")
  const at = new Date("2026-09-30T10:00:00Z")
  const rows = [
    { id: "a1", action: "storage.execute", target: "sdb1", success: true, createdAt: at, user: { username: "admin" },
      meta: JSON.stringify({ input: {}, plan: { op: "format", steps: [{ kind: "run", target: "/dev/sdb1", summary: "Format", status: "done" }] } }) },
    { id: "a2", action: "storage.mount", target: "sdb1", success: false, createdAt: at, user: null, meta: "{not json" },
  ]
  const out = activityEntries(rows as any)
  assert.deepEqual(out[0], { id: "a1", action: "storage.execute", target: "sdb1", success: true, at: at.toISOString(), user: "admin", op: "format", steps: [{ summary: "Format", status: "done" }] })
  assert.deepEqual(out[1], { id: "a2", action: "storage.mount", target: "sdb1", success: false, at: at.toISOString(), user: null })
}

// Activity lists what ran, not the previews shown before it.
{
  const { activityWhere } = await import("../services/storage-activity")
  assert.deepEqual(activityWhere(["sdb1"]), { target: { in: ["sdb1"] }, action: { notIn: ["storage.plan"] } })
  // An array's member operations are logged under the member device; the
  // array is found through the input they carry.
  assert.deepEqual(activityWhere(["md0", "/dev/md0"], ["md0"]), {
    OR: [{ target: { in: ["md0", "/dev/md0"] } }, { meta: { contains: '"name":"md0"' } }],
    action: { notIn: ["storage.plan"] },
  })
}

// The volumes page reuses the guard loop's last volume states instead of
// running the worker's (mounting, state-saving) check on every open.
{
  const { createVolumeCache } = await import("../services/volume-guard")
  let calls = 0, now = 1000
  const cache = createVolumeCache(async () => { calls++; return [{ mountPoint: "/srv", uuid: "u", state: "ok" as const, strayFiles: false }] }, () => now)
  await cache.get()
  assert.equal(calls, 1, "first read fetches")
  cache.set([{ mountPoint: "/srv", uuid: "u", state: "missing", strayFiles: false }])
  now += 30_000
  assert.equal((await cache.get())[0]!.state, "missing", "a recent guard result is reused")
  assert.equal(calls, 1)
  now += 120_000
  await cache.get()
  assert.equal(calls, 2, "a stale result is fetched again")
}

// Volume details: RAID 4 tolerance, resync wording, a guarded volume present
// but not mounted keeps what uses it.
{
  const { buildVolumes } = await import("../services/volumes")
  const dev = (o: any) => ({ fstype: "", mountpoint: "", uuid: "", size: 1e12, model: "", isSystem: false, usageTotal: 0, usageUsed: 0, usageFree: 0, children: [], ...o })
  const md4 = dev({ name: "md4", type: "raid4", fstype: "ext4", uuid: "U-R4", mountpoint: "/srv/r4", usageTotal: 3e12, usageUsed: 1e12, usageFree: 2e12 })
  const o = buildVolumes({
    devices: [
      dev({ name: "sdb", type: "disk", children: [dev({ name: "sdb1", type: "part", fstype: "linux_raid_member", children: [md4] })] }),
      dev({ name: "sdc", type: "disk", fstype: "ext4", uuid: "U-G" }),
    ],
    raids: [{ name: "md4", level: "raid4", state: "active", active: 3, total: 3, resyncPercent: 12, syncAction: "resync" }],
    lvm: { pvs: [], vgs: [], lvs: [] },
    guard: [{ mountPoint: "/srv/guarded", uuid: "U-G", state: "missing" }],
    holds: [],
    places: [{ id: "p1", name: "Archive", path: "/srv/guarded/archive" }],
    shares: [], apps: [],
  } as any)
  const r4 = o.volumes.find(v => v.id === "U-R4")!
  assert.equal(r4.redundancy, "raid4")
  assert.equal(r4.tolerates, 1)
  assert.match(r4.issues.find(i => i.kind === "rebuilding")!.text, /resyncing/)
  const g = o.volumes.find(v => v.id === "U-G")!
  assert.equal(g.state, "not-mounted")
  assert.deepEqual(g.usedBy.places, [{ id: "p1", name: "Archive" }], "a guarded volume keeps its Places while not mounted")
}

// Plan follow-ups (#36): apps, shares, users.
{
  const ap = await import("../services/app-plan")
  const stacks: Record<string, string> = {
    web: "services:\n  web:\n    image: nginx:1.27\n",
    broken: "services: [unclosed\n",
    duo: "services:\n  db:\n    image: postgres:16\n  app:\n    image: ghcr.io/x/app:2\n",
  }
  const fx = async () => undefined
  const deps: any = {
    stackPath: (n: string) => `/opt/containers/${n}/compose.yaml`,
    readStack: async (n: string) => stacks[n] ?? null,
    findPlace: async () => null, placeAtPath: async () => false, catalog: () => undefined, secret: () => "x",
    effects: { writeStack: fx, removeStackDir: fx, mkdirp: fx, createPlace: fx, validate: fx, publishJob: async () => "job-1" },
  }
  // A hand-broken compose file is a clear error, not an internal one.
  await assert.rejects(ap.buildAppPlan("app.apply", { name: "broken" }, deps), (e: any) => e.code === "BAD_REQUEST" && /not valid YAML/.test(e.message))
  // Every service image is named.
  const duo = await ap.buildAppPlan("app.start", { name: "duo" }, deps)
  assert.match(duo.steps[0]!.summary, /postgres:16/)
  assert.match(duo.steps[0]!.summary, /ghcr\.io\/x\/app:2/)
  // Saving the same content says so.
  const same = await ap.buildAppPlan("app.save", { name: "web", raw: stacks.web }, deps)
  assert.match(same.steps[0]!.summary, /No change/)
  // The form's name must be the app's name.
  const data = { name: "other", image: "nginx:1", ports: [], envs: [], volumes: [], networkNames: [], labels: [], capAdd: [], capDrop: [], extraHosts: [], restartPolicy: "unless-stopped", hostname: null, user: null, command: null, cpuLimit: null, memoryLimit: null }
  await assert.rejects(ap.buildAppPlan("app.save", { name: "web", data }, deps), /name/i)
  // Secrets in flow lists (command: ["--password=x"]) are masked.
  const masked = ap.maskSecrets('    command: ["--db-password=hunter2", "--port=80"]\n')
  assert.ok(!masked.includes("hunter2") && masked.includes("--port=80"), masked)

  // Share plans: an unexpected worker failure is a server error.
  const { workerError } = await import("../services/sharing-plan")
  assert.throws(() => workerError(Object.assign(new Error("nats: timeout"), {})), (e: any) => e.code === "INTERNAL_SERVER_ERROR")
  assert.throws(() => workerError(Object.assign(new Error("invalid share name"), { code: "ERR" })), (e: any) => e.code === "BAD_REQUEST")

  // User creation: a failed database write after the worker plan ran is
  // reported with the steps that ran (so it is audited), not thrown away.
  const up = await import("../services/user-plan")
  const res = await up.applyUserCreate({ username: "alice", password: "pw123456", samba: true }, "f", {
    worker: async () => ({ ok: true, steps: [{ kind: "run", target: "alice", summary: "useradd" }], results: [{ status: "done" }] }),
    smbdInstalled: async () => true, shareDefs: async () => [], currentShareDefs: async () => [],
    serialize: (fn: any) => fn(), resync: async () => {},
    commit: async () => { throw new Error("Unique constraint failed") },
  } as any)
  assert.equal(res.ok, false)
  assert.equal(res.results.at(-1)!.status, "failed")
  assert.match(res.error!, /Unique constraint/)
  assert.equal(res.steps.length, 2, "the worker step and the HSI user step")
}

// Create volume (#40): one plan from the worker chain, a Place and a share.
{
  const vp = await import("../services/volume-plan")
  const calls: string[] = []
  const volStep = { kind: "run", target: "/dev/md0", summary: "Create the array" }
  const smbStep = { kind: "update", target: "/etc/nasui/samba/smb.conf", summary: "Update the Samba configuration" }
  const deps = (over: Record<string, unknown> = {}): any => ({
    isAdmin: true,
    smbdInstalled: async () => true,
    shareDefs: async () => [],
    serialize: async (fn: any) => fn(),
    resync: async () => { calls.push("resync") },
    createPlace: async () => { calls.push("place"); return { id: "p-new" } },
    createShare: async (id: string) => { calls.push(`share:${id}`) },
    worker: async (subject: string, payload: any) => {
      calls.push(`${subject}:${payload.op}`)
      if (subject === "root.plan.preview") return payload.op === "smb.sync" ? { steps: [smbStep], fingerprint: "s1" } : { steps: [volStep], fingerprint: "v1" }
      return { ok: true, steps: payload.op === "smb.sync" ? [smbStep] : [volStep], results: [{ status: "done" }] }
    },
    ...over,
  })
  const input = { volume: { disks: ["sdf", "sdg"], mountpoint: "/srv/data" }, place: { name: "Data" }, share: { smbName: "data" } }

  const pv = await vp.previewVolume(input as any, deps())
  assert.deepEqual(pv.steps.map(s => s.summary), ["Create the array", 'Create the Place "Data" on /srv/data', "Update the Samba configuration"])

  calls.length = 0
  const ok = await vp.applyVolume(input as any, pv.fingerprint, deps())
  assert.equal(ok.ok, true)
  assert.ok(calls.indexOf("place") < calls.indexOf("share:p-new"), "the Place exists before its share")
  assert.equal(ok.reply?.placeId, "p-new")

  // A failed worker plan: no Place, no share.
  calls.length = 0
  const failed = await vp.applyVolume(input as any, pv.fingerprint, deps({
    worker: async (subject: string, payload: any) => subject === "root.plan.preview"
      ? (payload.op === "smb.sync" ? { steps: [smbStep], fingerprint: "s1" } : { steps: [volStep], fingerprint: "v1" })
      : { ok: false, error: "mkfs failed", steps: [volStep], results: [{ status: "failed", error: "mkfs failed" }] },
  }))
  assert.equal(failed.ok, false)
  assert.ok(!calls.includes("place"), "no Place after a failed volume")
  assert.deepEqual(failed.results.slice(-2).map(r => r.status), ["not-run", "not-run"])

  // A failed Place write: the share does not run.
  const noPlace = await vp.applyVolume(input as any, pv.fingerprint, deps({ createPlace: async () => { throw new Error("path taken") } }))
  assert.equal(noPlace.ok, false)
  assert.deepEqual(noPlace.results.slice(-2).map(r => r.status), ["failed", "not-run"])

  // The share fails after the disks were erased: a partial result, not an error
  // that reads as "nothing happened".
  const applyOk = (op: string) => ({ ok: true, steps: [volStep], results: [{ status: "done" }], reply: { mountpoint: "/srv/data" }, op })
  const previewOk = (payload: any) => payload.op === "smb.sync" ? { steps: [smbStep], fingerprint: "s1" } : { steps: [volStep], fingerprint: "v1" }
  calls.length = 0
  const staleShare = await vp.applyVolume(input as any, pv.fingerprint, deps({
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.preview") return previewOk(payload)
      if (payload.op === "smb.sync") throw Object.assign(new Error("smb.conf changed"), { code: "ESTALE" })
      return applyOk(payload.op)
    },
  }))
  assert.equal(staleShare.ok, false)
  assert.match(staleShare.error!, /volume and its Place are ready, but sharing failed: smb.conf changed/)
  assert.equal(staleShare.results.length, staleShare.steps.length)
  assert.equal(staleShare.results.at(-1)!.status, "failed")
  assert.equal(staleShare.reply?.placeId, "p-new")
  const rowFails = await vp.applyVolume(input as any, pv.fingerprint, deps({ createShare: async () => { throw new Error("Unique constraint") } }))
  assert.equal(rowFails.ok, false)
  assert.match(rowFails.error!, /sharing failed: Unique constraint/)
  assert.ok(calls.includes("resync"), "Samba is resynced to the stored shares")

  // The volume apply times out: it may still be running, say so.
  await assert.rejects(vp.applyVolume(input as any, pv.fingerprint, deps({
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.preview") return previewOk(payload)
      throw new TimeoutError()
    },
  })), (e: any) => /may still be running/.test(e.message))

  // A refusal from the worker at apply time is an answer, shown as such.
  await assert.rejects(vp.applyVolume(input as any, pv.fingerprint, deps({
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.preview") return previewOk(payload)
      throw Object.assign(new Error("sdf belongs to the system disk"), { code: "ESYS" })
    },
  })), (e: any) => /system disk/.test(e.message) && !/may still be running/.test(e.message))

  // Stale: CONFLICT.
  await assert.rejects(vp.applyVolume(input as any, "other", deps()), (e: any) => e.code === "CONFLICT")
  // Places and shares are for admins.
  await assert.rejects(vp.previewVolume(input as any, deps({ isAdmin: false })), (e: any) => e.code === "FORBIDDEN")
  // Without a Place there is no share.
  await assert.rejects(vp.previewVolume({ volume: input.volume, share: { smbName: "x" } } as any, deps()), (e: any) => e.code === "BAD_REQUEST")
}

// Remove volume (#40): shares off first, then the worker chain, then the Places.
{
  const vr = await import("../services/volume-remove-plan")
  const calls: string[] = []
  const volStep = { kind: "run", target: "/dev/data/data", summary: "Delete the logical volume" }
  const smbStep = { kind: "update", target: "/etc/nasui/samba/smb.conf", summary: "Update the Samba configuration" }
  const preview = (payload: any) => payload.op === "smb.sync" ? { steps: [smbStep], fingerprint: "s1" } : { steps: [volStep], fingerprint: "v1" }
  const deps = (over: Record<string, unknown> = {}): any => ({
    isAdmin: true,
    syncAccess: async () => {},
    smbdInstalled: async () => true,
    shareDefsWithout: async () => [],
    serialize: async (fn: any) => fn(),
    resync: async () => { calls.push("resync") },
    deletePlace: async (id: string) => { calls.push(`place:${id}`) },
    releaseHold: async (mp: string) => { calls.push(`hold:${mp}`) },
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.preview") return preview(payload)
      calls.push(`apply:${payload.op}`)
      return { ok: true, steps: payload.op === "smb.sync" ? [smbStep] : [volStep], results: [{ status: "done" }], reply: { freed: ["/dev/sda"] } }
    },
    ...over,
  })
  const target = { uuid: "fs-1", mountPoint: "/srv/data", name: "data", places: [{ id: "p1", name: "Photos" }], apps: [], shared: true, shareNames: ["photos"] }

  const pv = await vr.previewVolumeRemove(target, deps())
  assert.deepEqual(pv.steps.map(s => s.summary), ["Update the Samba configuration", "Delete the logical volume", 'Delete the Place "Photos"'])
  const unshared = await vr.previewVolumeRemove({ ...target, shared: false }, deps())
  assert.equal(unshared.steps[0]!.summary, "Delete the logical volume", "no Samba part without a share")

  await assert.rejects(vr.previewVolumeRemove({ ...target, apps: ["immich"] }, deps()),
    (e: any) => e.code === "PRECONDITION_FAILED" && /immich/.test(e.message))

  calls.length = 0
  const ok = await vr.applyVolumeRemove(target, pv.fingerprint, deps())
  assert.equal(ok.ok, true)
  assert.deepEqual(calls, ["apply:smb.sync", "apply:volume.remove", "place:p1", "hold:/srv/data"])
  assert.equal(ok.results.length, ok.steps.length)

  // The chain fails: the Places stay, Samba gets its shares back.
  calls.length = 0
  const failed = await vr.applyVolumeRemove(target, pv.fingerprint, deps({
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.preview") return preview(payload)
      calls.push(`apply:${payload.op}`)
      return payload.op === "smb.sync"
        ? { ok: true, steps: [smbStep], results: [{ status: "done" }] }
        : { ok: false, error: "vgremove failed", steps: [volStep], results: [{ status: "failed", error: "vgremove failed" }] }
    },
  }))
  assert.equal(failed.ok, false)
  assert.ok(!calls.some(c => c.startsWith("place:")), "no Place deleted")
  assert.ok(calls.includes("resync"))
  assert.equal(failed.results.at(-1)!.status, "not-run")

  // No answer from the host.
  calls.length = 0
  await assert.rejects(vr.applyVolumeRemove(target, pv.fingerprint, deps({
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.preview") return preview(payload)
      if (payload.op === "smb.sync") return { ok: true, steps: [smbStep], results: [{ status: "done" }] }
      throw new TimeoutError()
    },
  })), (e: any) => /may still be running/.test(e.message))
  assert.ok(calls.includes("resync"))

  // The Place cannot be deleted after the disks are erased.
  const noPlace = await vr.applyVolumeRemove(target, pv.fingerprint, deps({ deletePlace: async () => { throw new Error("locked") } }))
  assert.equal(noPlace.ok, false)
  assert.match(noPlace.error!, /^The disks are free, but the Place "Photos" could not be deleted: locked/)

  await assert.rejects(vr.applyVolumeRemove(target, "other", deps()), (e: any) => e.code === "CONFLICT")

  // Samba is told to let go first: the worker accepts smbd holding the folder.
  const inputs: any[] = []
  await vr.previewVolumeRemove(target, deps({ worker: async (subject: string, payload: any) => { inputs.push(payload); return preview(payload) } }))
  assert.deepEqual(inputs.find(p => p.op === "volume.remove").input, { uuid: "fs-1", closeShares: ["photos"] })

  // Like the worker: an apply is only accepted with the input of its preview.
  const seen = new Map<string, string>()
  const strict = deps({
    worker: async (subject: string, payload: any) => {
      const key = JSON.stringify(payload.input)
      if (subject === "root.plan.preview") { const p = preview(payload); seen.set(p.fingerprint, key); return { ...p, fingerprint: `${p.fingerprint}:${key}` } }
      if (payload.fingerprint !== `${payload.fingerprint.split(":")[0]}:${key}`) throw Object.assign(new Error("stale"), { code: "ESTALE" })
      return { ok: true, steps: [volStep], results: [{ status: "done" }] }
    },
  })
  const sp = await vr.previewVolumeRemove(target, strict)
  assert.equal((await vr.applyVolumeRemove(target, sp.fingerprint, strict)).ok, true, "apply sends the previewed input")

  // A refusal from the worker at apply time is an answer, shown as such.
  await assert.rejects(vr.applyVolumeRemove(target, pv.fingerprint, deps({
    worker: async (subject: string, payload: any) => {
      if (subject === "root.plan.preview") return preview(payload)
      if (payload.op === "smb.sync") return { ok: true, steps: [smbStep], results: [{ status: "done" }] }
      throw Object.assign(new Error("/srv/data is in use by bash; stop them first"), { code: "EBUSY" })
    },
  })), (e: any) => /in use by bash/.test(e.message) && !/may still be running/.test(e.message))

  // Admins only, checked by the plan itself too.
  await assert.rejects(vr.previewVolumeRemove(target, deps({ isAdmin: false })), (e: any) => e.code === "FORBIDDEN")

  // The hsi-share roster follows the deleted Places, after the share lock.
  calls.length = 0
  let locked = false
  await vr.applyVolumeRemove(target, pv.fingerprint, deps({
    serialize: async (fn: any) => { locked = true; try { return await fn() } finally { locked = false } },
    syncAccess: async () => { calls.push(locked ? "access:locked" : "access") },
  }))
  assert.equal(calls.at(-1), "access")

  // The volume as the Volumes page knows it.
  const vol = (o: any) => ({ id: "fs-1", name: "data", state: "mounted", mountPoint: "/srv/data", usedBy: { places: [], shares: [], apps: [] }, ...o })
  assert.equal(vr.removeTargetOf(vol({})).uuid, "fs-1")
  assert.throws(() => vr.removeTargetOf(vol({ id: "dev:sdf" })), (e: any) => e.code === "PRECONDITION_FAILED" && /no filesystem UUID/.test(e.message))
  assert.throws(() => vr.removeTargetOf(vol({ state: "missing" })), (e: any) => e.code === "PRECONDITION_FAILED")
}

// Expand a volume (#7): what each stack allows.
{
  const { expandOptions } = await import("../services/expand-options")
  const vol = (o: any = {}) => ({ id: "fs-1", name: "data", state: "mounted", fstype: "ext4", mountPoint: "/srv/data",
    stack: [{ kind: "filesystem", name: "data" }, { kind: "lv", name: "data/data" }, { kind: "vg", name: "data" }, { kind: "array", name: "md3" }], ...o })
  const dev = (name: string, size: number, children: any[] = []) => ({ name, size, type: "disk", children })
  const base = (o: any = {}) => ({
    lvm: { pvs: [{ name: "/dev/md3", vgName: "data", size: 64e9 }], vgs: [{ name: "data", free: 0 }], lvs: [{ name: "data", vgName: "data", path: "/dev/data/data" }] },
    raids: [{ name: "md3", level: "raid5", state: "active", active: 3, total: 3, members: [{ name: "sdc", role: "active" }, { name: "sdd", role: "active" }, { name: "sde", role: "active" }] }],
    devices: [dev("sdc", 32e9, [{ name: "md3", size: 64e9, type: "raid5" }]), dev("sdd", 32e9), dev("sde", 32e9), dev("sdf", 32e9), dev("sdg", 16e9)],
    freeDisks: [{ name: "sdf", size: 32e9 }, { name: "sdg", size: 16e9 }],
    expansions: [],
    ...o,
  })
  const modes = (r: any) => r.options.map((o: any) => o.mode)

  // RAID 5: a free disk as large as the members; the small one is left out.
  const r5 = expandOptions(vol() as any, base() as any)
  assert.deepEqual(modes(r5), ["raidAddDisk"])
  assert.deepEqual(r5.options[0]!.disks!.map((d: any) => d.name), ["sdf"])
  assert.equal(r5.options[0].gain, 32e9)

  // Free space in the VG comes first.
  const free = expandOptions(vol() as any, base({ lvm: { ...base().lvm, vgs: [{ name: "data", free: 10e9 }] } }) as any)
  assert.deepEqual(modes(free), ["vgFree", "raidAddDisk"])
  assert.equal(free.options[0].gain, 10e9)

  // A degraded array: nothing, with the reason.
  const degraded = expandOptions(vol() as any, base({ raids: [{ ...base().raids[0], active: 2 }] }) as any)
  assert.equal(degraded.options.length, 0)
  assert.match(degraded.reason!, /degraded/)

  // A mirror whose members grew.
  const mirror = expandOptions(vol({ stack: [{ kind: "filesystem", name: "data" }, { kind: "lv", name: "data/data" }, { kind: "vg", name: "data" }, { kind: "array", name: "md1" }] }) as any, base({
    lvm: { pvs: [{ name: "/dev/md1", vgName: "data", size: 30e9 }], vgs: [{ name: "data", free: 0 }], lvs: [{ name: "data", vgName: "data", path: "/dev/data/data" }] },
    raids: [{ name: "md1", level: "raid1", state: "active", active: 2, total: 2, members: [{ name: "sda", role: "active" }, { name: "sdb", role: "active" }] }],
    devices: [dev("sda", 40e9, [{ name: "md1", size: 30e9, type: "raid1" }]), dev("sdb", 40e9)],
    freeDisks: [],
  }) as any)
  assert.deepEqual(modes(mirror), ["mirrorGrow"])
  assert.equal(mirror.options[0].gain, 10e9)

  // Plain disks: add a disk.
  const plain = expandOptions(vol({ stack: [{ kind: "filesystem", name: "data" }, { kind: "lv", name: "data/data" }, { kind: "vg", name: "data" }, { kind: "disk", name: "sde" }] }) as any, base({
    lvm: { pvs: [{ name: "/dev/sde", vgName: "data", size: 32e9 }], vgs: [{ name: "data", free: 0 }], lvs: [{ name: "data", vgName: "data", path: "/dev/data/data" }] },
    raids: [],
  }) as any)
  assert.deepEqual(modes(plain), ["addDisk"])
  assert.deepEqual(plain.options[0]!.disks!.map((d: any) => d.name), ["sdf", "sdg"])

  // Not on LVM, unsupported filesystem, already expanding.
  assert.match(expandOptions(vol({ stack: [{ kind: "filesystem", name: "x" }, { kind: "disk", name: "sdf" }] }) as any, base() as any).reason!, /LVM/)
  assert.match(expandOptions(vol({ fstype: "vfat" }) as any, base() as any).reason!, /not supported/)
  assert.match(expandOptions(vol() as any, base({ expansions: [{ uuid: "fs-1", phase: "reshape" }] }) as any).reason!, /under way/)
}

// Expansion alerts: done announces the new size once, failed warns.
{
  const { expansionFindings } = await import("../services/expand-options")
  const out = expansionFindings([
    { uuid: "fs-1", lv: "/dev/data/data", mountpoint: "/srv/data", phase: "done", newSize: 96e9 },
    { uuid: "fs-2", lv: "/dev/b/b", mountpoint: "/srv/b", phase: "failed", error: "resize2fs: busy" },
    { uuid: "fs-3", lv: "/dev/c/c", mountpoint: "/srv/c", phase: "reshape" },
  ] as any)
  assert.deepEqual(out.found.map(f => [f.target, f.severity]), [["/srv/data", "info"], ["/srv/b", "warning"]])
  assert.match(out.found[0]!.message, /now has 96\.0 GB/)
  assert.deepEqual(out.ack, ["fs-1"])
  // Once announced, the volume is still checked with nothing found: the alert clears.
  const later = expansionFindings([{ uuid: "fs-1", lv: "/dev/data/data", mountpoint: "/srv/data", phase: "done", newSize: 96e9, announced: true }] as any)
  assert.equal(later.found.length, 0)
  assert.deepEqual(later.checked, ["/srv/data"])
  assert.deepEqual(later.ack, [])
}

// Storage descriptions (#37): one warning per volume that differs.
{
  const { descriptionFindings } = await import("../services/storage-descriptions")
  const item = (text: string) => ({ kind: "x", text })
  const out = descriptionFindings([
    { mountPoint: "/srv/a", file: "a.yaml", items: [], description: {} },
    { mountPoint: "/srv/b", file: "b.yaml", items: [item("The fstab entry for /srv/b is missing")], description: {} },
    { mountPoint: "/srv/c", file: "c.yaml", items: [item("/srv/c is not mounted"), item("x"), item("y")], description: {} },
  ])
  assert.deepEqual(out.checked, ["/srv/a", "/srv/b", "/srv/c"])
  assert.deepEqual(out.found.map(f => [f.target, f.severity]), [["/srv/b", "warning"], ["/srv/c", "warning"]])
  assert.equal(out.found[0]!.message, "/srv/b differs from its description: The fstab entry for /srv/b is missing")
  assert.equal(out.found[1]!.message, "/srv/c differs from its description: /srv/c is not mounted (and 2 more)")
}

// The worker lists every description: an alert whose description is gone
// (volume removed) clears instead of staying open.
{
  const { descriptionFindings } = await import("../services/storage-descriptions")
  const { checkedTargets } = await import("../services/alert-sampler")
  const out = descriptionFindings([])
  assert.equal(out.authoritative, true)
  // A file that cannot be read and matches no volume is named by its path.
  const broken = descriptionFindings([{ mountPoint: "", file: "/etc/hsi/storage/x.yaml", items: [{ kind: "unreadable", text: "cannot be read" }], description: {} }])
  assert.deepEqual(broken.found.map(f => f.target), ["/etc/hsi/storage/x.yaml"])
  assert.match(broken.found[0]!.message, /^\/etc\/hsi\/storage\/x\.yaml differs/)
  assert.deepEqual(checkedTargets(out, [{ target: "/srv/gone" }]), ["/srv/gone"])
  assert.deepEqual(checkedTargets({ found: [], checked: ["/a"] }, [{ target: "/srv/gone" }]), ["/a"])
}

// SmallTV (smalltv-mod) preset (#75): the device only knows info, warning,
// alert and done, and rejects anything else with a 400.
{
  const { eventVars, renderWebhookRequest, WEBHOOK_PRESETS } = await import("../services/notifications")
  const ev = (type: string, severity: string) => ({ type, severity, source: "storage.raid", target: "md0", message: "Array md0 is degraded", time: "2026-10-06T12:00:00Z" }) as any
  assert.equal(eventVars(ev("alert.raised", "critical"))["event.smalltvType"], "alert")
  assert.equal(eventVars(ev("alert.raised", "warning"))["event.smalltvType"], "warning")
  assert.equal(eventVars(ev("alert.raised", "info"))["event.smalltvType"], "info")
  assert.equal(eventVars(ev("job.failed", "critical"))["event.smalltvType"], "alert")
  assert.equal(eventVars(ev("alert.cleared", "critical"))["event.smalltvType"], "done")
  const preset = WEBHOOK_PRESETS.find(p => p.id === "smalltv")!
  assert.equal(preset.label, "SmallTV (smalltv-mod)")
  assert.equal(preset.url, "http://smalltv.local/api/notify")
  assert.match(preset.hint ?? "", /IP address/)
  assert.match(preset.hint ?? "", /password/)
  const req = renderWebhookRequest(preset, ev("alert.raised", "critical"))
  assert.deepEqual(JSON.parse(req.body), { type: "alert", title: "storage.raid", label: "md0: Array md0 is degraded" })
  assert.equal(req.method, "POST")
  assert.equal(req.headers["Content-Type"], "application/json")
}

// First-run setup (#12): the setup session only opens createAdmin, and setup
// ends as soon as an administrator exists.
{
  const { signSetupSession, verifySetupSession, verifyToken: verifyLogin, signToken: signLogin } = await import("../trpc/auth")
  const { setupStatus, checkSetupToken, recordProgress } = await import("../services/setup")
  const setupJwt = signSetupSession()
  assert.doesNotThrow(() => verifySetupSession(setupJwt))
  assert.throws(() => verifyLogin(setupJwt), "a setup session is not a login")
  assert.throws(() => verifySetupSession(signLogin("u1", true, false, [], false)), "a login is not a setup session")

  let admins = 0
  const tokenOk = true
  const state: { step: string; skipped: string[] } = { step: "admin", skipped: [] }
  const deps = {
    adminCount: async () => admins,
    workerVerify: async (t: string) => tokenOk && t === "good",
    getState: async () => ({ ...state }),
    setState: async (step: string, skipped: string[]) => { state.step = step; state.skipped = skipped },
  }
  assert.deepEqual(await setupStatus(deps), { required: true, step: "admin" })
  assert.equal(typeof await checkSetupToken(deps, "good", "10.0.0.9"), "string")
  await assert.rejects(checkSetupToken(deps, "bad", "10.0.0.9"), /not valid/)
  // Throttled like the login: five failures from one address.
  for (let i = 0; i < 4; i++) await assert.rejects(checkSetupToken(deps, "bad", "10.0.0.7"))
  await assert.rejects(checkSetupToken(deps, "bad", "10.0.0.7"))
  await assert.rejects(checkSetupToken(deps, "good", "10.0.0.7"), /Too many/i)

  admins = 1 // TestCreateAdminRefusedWhenAdminExists: a token left behind opens nothing
  await assert.rejects(checkSetupToken(deps, "good", "10.0.0.8"), /already done/)
  const { SETUP_STEPS } = await import("../services/setup")
  assert.deepEqual([...SETUP_STEPS], ["admin", "identity", "secure", "next", "done"])
  state.step = "identity"
  assert.deepEqual(await setupStatus(deps, { isAdmin: true }), { required: false, step: "identity" })
  state.step = "secure"
  assert.deepEqual(await setupStatus(deps, { isAdmin: true }), { required: false, step: "secure" })
  state.step = "identity"
  await recordProgress(deps, "next", "identity")
  assert.deepEqual(state, { step: "next", skipped: ["identity"] })
  await recordProgress(deps, "done")
  assert.deepEqual(await setupStatus(deps, { isAdmin: true }), { required: false, step: null })
  await assert.rejects(recordProgress(deps, "bogus" as never), /step/)
}

// createAdmin (#12 review): a setup session only, one administrator only,
// even with two calls at once; non-admins never see the setup step.
{
  const { signSetupSession, signToken: signLogin } = await import("../trpc/auth")
  const { createFirstAdmin, setupStatus } = await import("../services/setup")
  let admins = 0
  const created: string[] = []
  const deps = {
    adminCount: async () => admins,
    workerVerify: async () => true,
    getState: async () => ({ step: "identity", skipped: [] as string[] }),
    setState: async () => {},
  }
  const create = async (u: { username: string }) => {
    await new Promise(r => setTimeout(r, 20)) // useradd and bcrypt take time
    created.push(u.username); admins++
    return { id: u.username, username: u.username }
  }
  await assert.rejects(createFirstAdmin(deps, create, signLogin("u", true, false, [], false), { username: "a", password: "secret1" }), /expired/)
  await assert.rejects(createFirstAdmin(deps, create, "garbage", { username: "a", password: "secret1" }), /expired/)
  const s = signSetupSession()
  const results = await Promise.allSettled([
    createFirstAdmin(deps, create, s, { username: "alice", password: "secret1" }),
    createFirstAdmin(deps, create, s, { username: "bob", password: "secret1" }),
  ])
  assert.deepEqual(created, ["alice"], "one administrator, even with two calls at once")
  assert.equal(results.filter(r => r.status === "rejected").length, 1)
  await assert.rejects(createFirstAdmin(deps, create, signSetupSession(), { username: "carol", password: "secret1" }), /already done/)
  // Only an admin resumes the assistant; other accounts go to the dashboard.
  assert.deepEqual(await setupStatus(deps, { isAdmin: false }), { required: false, step: null })
  assert.deepEqual(await setupStatus(deps, { isAdmin: true }), { required: false, step: "identity" })
}

// Configuration backup v2 (#1): envelope, preview, conflicts, apply, v1.
{
  const { encryptToFile, decryptToFile, MAGIC_V1, MAGIC_V2 } = await import("../services/config-backup")
  const { previewConfigRestore, applyConfigRestore, compareVersions, sweepRestores } = await import("../services/config-restore")
  const { writeFile, readFile, mkdtemp: mkd, mkdir } = await import("node:fs/promises")
  const work = await mkd(join(tmpdir(), "hsi-backup-test-"))
  const password = "a-long-test-password-123"

  assert.ok(compareVersions("1.65.0", "v1.64.2") > 0 && compareVersions("v1.64.2", "1.64.2") === 0 && compareVersions("1.9.0", "1.10.0") < 0)

  // Envelope: the magic tells the format.
  const plain = join(work, "plain.tar")
  await writeFile(plain, Buffer.alloc(300, 7))
  await encryptToFile(plain, join(work, "v2.hsibak"), password, MAGIC_V2)
  await encryptToFile(plain, join(work, "v1.hsibak"), password, MAGIC_V1)
  assert.equal(await decryptToFile(join(work, "v2.hsibak"), password, join(work, "out2")), 2)
  assert.equal(await decryptToFile(join(work, "v1.hsibak"), password, join(work, "out1")), 1)
  assert.deepEqual(await readFile(join(work, "out2")), await readFile(plain))
  await assert.rejects(decryptToFile(join(work, "v2.hsibak"), "wrong-password-xxxxxx", join(work, "out3")), /password/)

  // A fake worker: unpack writes the database and secrets, check answers what the test sets.
  let check = { conflicts: [] as unknown[], apps: [{ name: "kuma", state: "new" }], volumes: [{ mountPoint: "/srv/data", disksPresent: 0, disksMissing: 2 }] }
  let manifestVersion = "1.64.0"
  const calls: string[] = []
  let now = 1_000_000
  const swapped: string[] = []
  const deps = {
    stagingRoot: async () => { const d = join(work, "staging"); await mkdir(d, { recursive: true }); return d },
    worker: async (subject: string, payload: Record<string, unknown>) => {
      calls.push(subject)
      if (subject === "root.config.unpack") {
        const dest = String(payload.dest)
        await mkdir(dest, { recursive: true })
        await writeFile(join(dest, "database.db"), "db")
        await writeFile(join(dest, "secrets.json"), JSON.stringify({ HSI_SECRETS_KEY: "c".repeat(64) }))
        return { format: 2, hsiVersion: manifestVersion, createdAt: "2026-10-06T10:00:00Z", hostname: "HSI", items: [] }
      }
      if (subject === "root.config.check") return check
      return {}
    },
    validateDb: async () => {},
    countRestored: async () => ({ users: 2, groups: 1, places: 3, shares: 1, connectors: 1, placePaths: ["/srv/data/photos"] }),
    pathExists: async () => false,
    currentVersion: () => "1.65.0",
    currentSecretsKey: () => "d".repeat(64),
    envPath: () => "/opt/hsi/.env",
    swapDatabase: async (file: string) => { swapped.push(file) },
    now: () => now,
  }
  const p = await previewConfigRestore(join(work, "v2.hsibak"), password, deps)
  assert.equal(p.format, 2)
  assert.deepEqual(p.backup, { hsiVersion: "1.64.0", createdAt: "2026-10-06T10:00:00Z", hostname: "HSI" })
  assert.deepEqual(p.contents, { users: 2, groups: 1, places: 3, shares: 1, connectors: 1, apps: ["kuma"], volumes: 1 })
  assert.ok(p.warnings.some(w => /\/srv\/data.*not connected/.test(w)) && p.warnings.some(w => /photos/.test(w)))
  await applyConfigRestore(p.token, "u1", "1.2.3.4", deps)
  assert.deepEqual(calls.slice(-2), ["root.config.apply", "root.config.secretsKey"])
  assert.equal(swapped.length, 1)
  await assert.rejects(applyConfigRestore(p.token, "u1", "1.2.3.4", deps), /expired|unknown/i, "a token is used once")

  // Conflicts block the apply; a newer backup is refused at the preview.
  check = { ...check, conflicts: [{ kind: "uid-taken", name: "alice", detail: "", command: "" }] }
  const blocked = await previewConfigRestore(join(work, "v2.hsibak"), password, deps)
  assert.equal(blocked.conflicts.length, 1)
  await assert.rejects(applyConfigRestore(blocked.token, "u1", "ip", deps), /conflict/i)
  manifestVersion = "1.99.0"
  await assert.rejects(previewConfigRestore(join(work, "v2.hsibak"), password, deps), /newer/)
  manifestVersion = "1.64.0"

  // Previews expire after 15 minutes.
  check = { ...check, conflicts: [] }
  const late = await previewConfigRestore(join(work, "v2.hsibak"), password, deps)
  now += 16 * 60_000
  await sweepRestores(deps)
  await assert.rejects(applyConfigRestore(late.token, "u1", "ip", deps), /expired|unknown/i)

  // A v1 file: database only, no worker apply.
  calls.length = 0
  const v1 = await previewConfigRestore(join(work, "v1.hsibak"), password, deps)
  assert.equal(v1.format, 1)
  await applyConfigRestore(v1.token, "u1", "ip", deps)
  assert.ok(!calls.includes("root.config.apply"))
  await rm(work, { recursive: true, force: true })
}

// Restore review follow-ups (#1): the secrets key is rolled back when the
// database swap fails, a bad secrets file stops before anything is applied,
// a cancelled preview is removed at once.
{
  const { encryptToFile, MAGIC_V2 } = await import("../services/config-backup")
  const { previewConfigRestore, applyConfigRestore, cancelConfigRestore } = await import("../services/config-restore")
  const { writeFile, mkdtemp: mkd, mkdir, readdir } = await import("node:fs/promises")
  const work = await mkd(join(tmpdir(), "hsi-backup-test2-"))
  const password = "a-long-test-password-123"
  await writeFile(join(work, "plain"), Buffer.alloc(300, 1))
  await encryptToFile(join(work, "plain"), join(work, "v2.hsibak"), password, MAGIC_V2)
  let secrets = JSON.stringify({ HSI_SECRETS_KEY: "b".repeat(64) })
  const calls: string[] = []
  const swapFails = true
  const deps = {
    stagingRoot: async () => { const d = join(work, "staging"); await mkdir(d, { recursive: true }); return d },
    worker: async (subject: string, payload: Record<string, unknown>) => {
      calls.push(subject)
      if (subject === "root.config.unpack") {
        const dest = String(payload.dest)
        await mkdir(dest, { recursive: true })
        await writeFile(join(dest, "database.db"), "db")
        await writeFile(join(dest, "secrets.json"), secrets)
        return { format: 2, hsiVersion: "1.65.0" }
      }
      if (subject === "root.config.check") return { conflicts: [], apps: [], volumes: [] }
      if (subject === "root.config.secretsKey") return { backup: "/opt/hsi/.env.before-restore-x" }
      return {}
    },
    validateDb: async () => {},
    countRestored: async () => ({ users: 0, groups: 0, places: 0, shares: 0, connectors: 0, placePaths: [] }),
    pathExists: async () => true,
    currentVersion: () => "1.65.0",
    currentSecretsKey: () => "a".repeat(64),
    envPath: () => "",
    swapDatabase: async () => { if (swapFails) throw new Error("disk full") },
    now: () => Date.now(),
  }
  const p = await previewConfigRestore(join(work, "v2.hsibak"), password, deps)
  await assert.rejects(applyConfigRestore(p.token, "u", "ip", deps), /disk full/)
  assert.deepEqual(calls.slice(-3), ["root.config.apply", "root.config.secretsKey", "root.config.secretsRestore"])

  secrets = "{not json"
  calls.length = 0
  const bad = await previewConfigRestore(join(work, "v2.hsibak"), password, deps)
  await assert.rejects(applyConfigRestore(bad.token, "u", "ip", deps), /secrets/i)
  assert.ok(!calls.includes("root.config.apply"), "nothing applied with an unreadable secrets file")

  secrets = JSON.stringify({ HSI_SECRETS_KEY: "b".repeat(64) })
  const c = await previewConfigRestore(join(work, "v2.hsibak"), password, deps)
  await cancelConfigRestore(c.token)
  assert.deepEqual(await readdir(join(work, "staging")), [], "a cancelled preview leaves nothing")
  await assert.rejects(applyConfigRestore(c.token, "u", "ip", deps), /expired|unknown/i)
  await rm(work, { recursive: true, force: true })
}

// The startup purge removes what an earlier run left, never a preview or an
// export this run has just started.
{
  const { purgeStaging } = await import("../services/config-restore")
  const { mkdtemp: mkd, mkdir, readdir, utimes } = await import("node:fs/promises")
  const root = await mkd(join(tmpdir(), "hsi-staging-purge-"))
  await mkdir(join(root, "restore-old"))
  await mkdir(join(root, "export-old"))
  await mkdir(join(root, "restore-new"))
  await mkdir(join(root, "other"))
  const startedAt = Date.now()
  const past = new Date(startedAt - 60_000)
  for (const d of ["restore-old", "export-old", "other"]) await utimes(join(root, d), past, past)
  await utimes(join(root, "restore-new"), new Date(startedAt + 1_000), new Date(startedAt + 1_000))
  await purgeStaging(root, startedAt)
  assert.deepEqual((await readdir(root)).sort(), ["other", "restore-new"])
  await rm(root, { recursive: true, force: true })
}

// Restore from the first-run assistant (#1, #12): a setup session opens the
// restore only while no administrator exists; a backup without one is refused.
{
  const { restoreCaller } = await import("../services/config-restore")
  assert.deepEqual(restoreCaller({ adminUserId: "u1", setupSession: false, adminCount: 3 }), { userId: "u1", setup: false })
  assert.deepEqual(restoreCaller({ adminUserId: null, setupSession: true, adminCount: 0 }), { userId: "", setup: true })
  assert.equal(restoreCaller({ adminUserId: null, setupSession: true, adminCount: 1 }), null, "setup is over: a setup session opens nothing")
  assert.equal(restoreCaller({ adminUserId: null, setupSession: false, adminCount: 0 }), null)

  const { encryptToFile, MAGIC_V2 } = await import("../services/config-backup")
  const { previewConfigRestore } = await import("../services/config-restore")
  const { writeFile, mkdtemp: mkd, mkdir } = await import("node:fs/promises")
  const work = await mkd(join(tmpdir(), "hsi-backup-test3-"))
  await writeFile(join(work, "plain"), Buffer.alloc(300, 2))
  await encryptToFile(join(work, "plain"), join(work, "v2.hsibak"), "a-long-test-password-123", MAGIC_V2)
  const deps = {
    stagingRoot: async () => { const d = join(work, "staging"); await mkdir(d, { recursive: true }); return d },
    worker: async (subject: string, payload: Record<string, unknown>) => {
      if (subject === "root.config.unpack") { await mkdir(String(payload.dest), { recursive: true }); await writeFile(join(String(payload.dest), "database.db"), "db"); return { format: 2, hsiVersion: "1.65.0" } }
      return { conflicts: [], apps: [], volumes: [] }
    },
    validateDb: async () => {},
    countRestored: async () => ({ users: 1, admins: 0, groups: 0, places: 0, shares: 0, connectors: 0, placePaths: [] }),
    pathExists: async () => true, currentVersion: () => "1.65.0", currentSecretsKey: () => undefined, envPath: () => "",
    swapDatabase: async () => {}, now: () => Date.now(),
  }
  await assert.rejects(previewConfigRestore(join(work, "v2.hsibak"), "a-long-test-password-123", deps), /administrator/)
  await rm(work, { recursive: true, force: true })
}

// App updates (#26): an installed App Store app whose catalog image moved on.
{
  const au = await import("../services/app-update")
  assert.deepEqual(au.availableUpdate("louislam/uptime-kuma:1.23.15", "louislam/uptime-kuma:1.23.16"), { from: "1.23.15", to: "1.23.16", image: "louislam/uptime-kuma:1.23.16" })
  assert.equal(au.availableUpdate("louislam/uptime-kuma:1.23.16", "louislam/uptime-kuma:1.23.16"), null)
  assert.equal(au.availableUpdate("louislam/uptime-kuma:2.0.0", "louislam/uptime-kuma:1.23.16"), null, "a newer tag set by hand is not downgraded")
  assert.equal(au.availableUpdate("someone/kuma-fork:1.0", "louislam/uptime-kuma:1.23.16"), null, "another image is the admin's choice")
  assert.deepEqual(au.availableUpdate("adguard/adguardhome:v0.107.52", "adguard/adguardhome:v0.107.55")?.to, "v0.107.55")
  assert.ok(au.availableUpdate("corentinth/it-tools:2024.10.22-7ca5933", "corentinth/it-tools:2025.1.6-aaaaaaa"))
  assert.ok(au.availableUpdate("syncthing/syncthing:1.27", "syncthing/syncthing:1.27.1"))
  assert.ok(au.availableUpdate("localhost:5000/app:1.0", "localhost:5000/app:1.1"), "a registry port is not a tag")
  assert.equal(au.availableUpdate("x/app:1.0-rc", "x/app:1.0-beta"), null, "same version, other suffix: not comparable")
  assert.equal(au.availableUpdate("x/app:edge", "x/app:1.0"), null, "a tag that is not a version is left alone")
  assert.equal(au.availableUpdate(`x/app@sha256:${"a".repeat(64)}`, "x/app:1.0"), null)

  const yaml = "services:\n  kuma:\n    image: louislam/uptime-kuma:1.23.15\n    labels:\n      hsi.catalog.id: uptime-kuma\n"
  assert.equal(au.replaceImage(yaml, "louislam/uptime-kuma:1.23.15", "louislam/uptime-kuma:1.23.16"),
    "services:\n  kuma:\n    image: louislam/uptime-kuma:1.23.16\n    labels:\n      hsi.catalog.id: uptime-kuma\n")
  assert.equal(au.replaceImage('    image: "a/b:1"\n', "a/b:1", "a/b:2"), '    image: "a/b:2"\n', "quotes are kept")
  assert.throws(() => au.replaceImage("services:\n  a:\n    image: a/b:1\n  c:\n    image: a/b:1\n", "a/b:1", "a/b:2"), /used by 2 services/)
  assert.throws(() => au.replaceImage(yaml, "a/b:1", "a/b:2"), /not found/)

  const ap = await import("../services/app-plan")
  const { generateComposeYaml } = await import("@app/compose")
  const kuma = (image: string) => generateComposeYaml({
    name: "kuma", image, ports: [], envs: [{ key: "ADMIN_PASSWORD", value: "hunter2" }], volumes: [], networkNames: [],
    labels: [{ key: "hsi.catalog.id", value: "uptime-kuma" }], capAdd: [], capDrop: [], extraHosts: [],
    restartPolicy: "unless-stopped", hostname: null, user: null, command: null, cpuLimit: null, memoryLimit: null,
  } as any)
  const stacks: Record<string, string> = { kuma: kuma("louislam/uptime-kuma:1.23.15"), web: "services:\n  web:\n    image: nginx:1.27\n" }
  const previous: Record<string, string> = {}
  const status: Record<string, string> = { kuma: "running", web: "running" }
  const calls: string[] = []
  const effect = (n: string) => async (...args: unknown[]) => { calls.push(`${n}:${String(args[0])}`); return n === "publishJob" ? "job-9" : undefined }
  const deps: import("../services/app-plan").AppPlanDeps = {
    stackPath: (n) => `/opt/containers/${n}/compose.yaml`,
    readStack: async (n) => stacks[n] ?? null,
    readPrevious: async (n) => previous[n] ?? null,
    appStatus: async (n) => status[n] ?? "unknown",
    findPlace: async () => null, placeAtPath: async () => false,
    catalog: (id) => (id === "uptime-kuma" ? { id, name: "Uptime Kuma", image: "louislam/uptime-kuma:1.23.16", env: [{ key: "ADMIN_PASSWORD", secret: true }] } as any : undefined),
    secret: () => "x",
    effects: {
      writeStack: effect("writeStack") as any, removeStackDir: effect("removeStackDir") as any, mkdirp: effect("mkdirp") as any,
      createPlace: effect("createPlace") as any, validate: effect("validate") as any, publishJob: effect("publishJob") as any,
      writePrevious: effect("writePrevious") as any, removePrevious: effect("removePrevious") as any,
    },
  }

  // Running: the image line changes, the old file is kept, the app is recreated.
  const up = await ap.buildAppPlan("app.update", { name: "kuma" }, deps)
  assert.deepEqual(up.steps.map(s => s.kind), ["update", "run"])
  assert.match(up.steps[0]!.diff!, /^- {4}image: louislam\/uptime-kuma:1\.23\.15$/m)
  assert.match(up.steps[0]!.diff!, /^\+ {4}image: louislam\/uptime-kuma:1\.23\.16$/m)
  assert.match(up.steps[0]!.summary, /compose\.yaml\.previous/)
  assert.ok(!JSON.stringify(ap.publicSteps(up)).includes("hunter2"))
  assert.match(up.steps[1]!.summary, /1\.23\.16/)
  assert.equal(up.observed.status, "running")
  const res = await ap.executeAppPlan(up)
  assert.equal(res.ok, true)
  assert.deepEqual(calls, ["writePrevious:kuma", "writeStack:kuma", "validate:kuma", "publishJob:container.composeUp"])

  // Stopped: only the file changes; the image comes with the next start.
  status.kuma = "stopped"
  const stopped = await ap.buildAppPlan("app.update", { name: "kuma" }, deps)
  assert.deepEqual(stopped.steps.map(s => s.kind), ["update"])
  assert.match(stopped.steps[0]!.summary, /when it starts/)
  assert.notEqual(ap.appFingerprint(stopped, { name: "kuma" }), ap.appFingerprint(up, { name: "kuma" }), "the app's state is part of the plan")

  // A failed validation puts the file back and drops the kept copy.
  calls.length = 0
  const failing = { ...deps, effects: { ...deps.effects, validate: async () => { throw new Error("invalid compose") } } }
  const bad = await ap.executeAppPlan(await ap.buildAppPlan("app.update", { name: "kuma" }, failing))
  assert.equal(bad.ok, false)
  assert.deepEqual(calls, ["writePrevious:kuma", "writeStack:kuma", "writeStack:kuma", "removePrevious:kuma"])

  // Nothing to update, or not an App Store app.
  stacks.kuma = kuma("louislam/uptime-kuma:1.23.16")
  await assert.rejects(ap.buildAppPlan("app.update", { name: "kuma" }, deps), (e: any) => e.code === "BAD_REQUEST" && /up to date/.test(e.message))
  await assert.rejects(ap.buildAppPlan("app.update", { name: "web" }, deps), /App Store/)
  await assert.rejects(ap.buildAppPlan("app.update", { name: "nope" }, deps), /not found/i)

  // Rollback: the kept file comes back, then it is removed.
  await assert.rejects(ap.buildAppPlan("app.rollback", { name: "kuma" }, deps), (e: any) => e.code === "NOT_FOUND")
  previous.kuma = kuma("louislam/uptime-kuma:1.23.15")
  status.kuma = "running"
  const back = await ap.buildAppPlan("app.rollback", { name: "kuma" }, deps)
  assert.deepEqual(back.steps.map(s => s.kind), ["update", "run"])
  assert.match(back.steps[0]!.diff!, /^\+ {4}image: louislam\/uptime-kuma:1\.23\.15$/m)
  // Only the image goes back: an edit made after the update is kept.
  stacks.kuma = stacks.kuma!.replace("restart: unless-stopped", "restart: always")
  const kept = await ap.buildAppPlan("app.rollback", { name: "kuma" }, deps)
  assert.equal(kept.steps[0]!.diff!.split("\n").filter(l => /^[-+] /.test(l)).length, 2, kept.steps[0]!.diff ?? "")
  // A rollback starts the app whatever its state: a crash-looping update reads as stopped.
  status.kuma = "stopped"
  const fromStopped = await ap.buildAppPlan("app.rollback", { name: "kuma" }, deps)
  assert.deepEqual(fromStopped.steps.map(s => s.kind), ["update", "run"])
  assert.equal(ap.appFingerprint(fromStopped, { name: "kuma" }), ap.appFingerprint(kept, { name: "kuma" }), "a flapping status does not make the rollback stale")
  previous.kuma = stacks.kuma!
  await assert.rejects(ap.buildAppPlan("app.rollback", { name: "kuma" }, deps), /same image/)
  previous.kuma = kuma("louislam/uptime-kuma:1.23.15")
  calls.length = 0
  assert.equal((await ap.executeAppPlan(back)).ok, true)
  assert.deepEqual(calls, ["writeStack:kuma", "validate:kuma", "removePrevious:kuma", "publishJob:container.composeUp"])
}

// App updates (#26), review minors.
{
  const au = await import("../services/app-update")
  assert.equal(au.availableUpdate("x/app:1.2.3-alpine", "x/app:1.3.0"), null, "a variant set by hand is not dropped")
  assert.ok(au.availableUpdate("x/app:1.2.3-alpine", "x/app:1.3.0-alpine"))
  assert.deepEqual(au.availableUpdate("linuxserver/qbittorrent:5.0.2-ls10", "linuxserver/qbittorrent:5.0.2-ls11")?.to, "5.0.2-ls11", "a revision bump")
  assert.equal(au.availableUpdate("linuxserver/qbittorrent:5.0.2-ls11", "linuxserver/qbittorrent:5.0.2-ls10"), null)
  assert.ok(au.availableUpdate("corentinth/it-tools:2024.10.22-7ca5933", "corentinth/it-tools:2025.1.6-aaaaaaa"), "a commit hash is not a variant")
  assert.ok(au.availableUpdate("docker.io/louislam/uptime-kuma:1.23.15", "louislam/uptime-kuma:1.23.16"), "docker.io prefix")
  assert.ok(au.availableUpdate("docker.io/library/nginx:1.27", "nginx:1.28"), "library prefix")
  assert.equal(au.replaceImage("    image: a/b:1 # pinned\n", "a/b:1", "a/b:2"), "    image: a/b:2 # pinned\n", "a trailing comment is kept")
  assert.equal(au.replaceImage("x:\n\n    image: a/b:1\n", "a/b:1", "a/b:2"), "x:\n\n    image: a/b:2\n")

  const { zAppManifest } = await import("@app/app-catalog")
  const base = { id: "x", name: "X", category: "Utilities", added: "2026-01-01", tagline: "t", description: "d", image: "x/x:1" }
  assert.equal(zAppManifest.safeParse({ ...base, changelog: "javascript:alert(1)" }).success, false)
  assert.equal(zAppManifest.safeParse({ ...base, changelog: "http://example.com" }).success, false)
  assert.equal(zAppManifest.safeParse({ ...base, changelog: "https://example.com/releases" }).success, true)
  assert.equal(zAppManifest.safeParse({ ...base, added: "29/10/2026" }).success, false, "added is a YYYY-MM-DD date")
  assert.equal(zAppManifest.safeParse({ ...base, source: "http://example.com" }).success, false, "source links are HTTPS")
  assert.equal(zAppManifest.safeParse({ ...base, license: "<b>GPL</b>" }).success, false)
  assert.equal(zAppManifest.safeParse({ ...base, postInstall: Array(7).fill("step") }).success, false, "a few first steps, not a manual")
  // Every app in the store says what it is licensed under, where its code is,
  // and what to do once it runs (#26).
  for (const m of (await import("@app/app-catalog")).CATALOG) {
    assert.ok(m.license && m.source && m.postInstall.length, `${m.id}: license, source and postInstall are filled`)
  }

  // A failed update puts back the earlier rollback point, whatever step failed.
  const ap = await import("../services/app-plan")
  const yaml = "services:\n  kuma:\n    image: louislam/uptime-kuma:1.23.15\n    labels:\n      hsi.catalog.id: uptime-kuma\n"
  for (const failAt of ["writeStack", "validate"]) {
    const files = { stack: yaml, previous: "OLDER" as string | null }
    let writes = 0
    const deps: any = {
      stackPath: (n: string) => `/opt/containers/${n}/compose.yaml`,
      readStack: async () => files.stack, readPrevious: async () => files.previous, appStatus: async () => "stopped",
      findPlace: async () => null, placeAtPath: async () => false, secret: () => "x",
      catalog: (id: string) => (id === "uptime-kuma" ? { id, image: "louislam/uptime-kuma:1.23.16", env: [] } : undefined),
      effects: {
        writeStack: async (_n: string, y: string) => { if (failAt === "writeStack" && writes++ === 0) throw new Error("disk full"); files.stack = y },
        validate: async () => { if (failAt === "validate") throw new Error("invalid") },
        writePrevious: async (_n: string, y: string) => { files.previous = y },
        removePrevious: async () => { files.previous = null },
        removeStackDir: async () => {}, mkdirp: async () => {}, createPlace: async () => "", publishJob: async () => "j",
      },
    }
    const r = await ap.executeAppPlan(await ap.buildAppPlan("app.update", { name: "kuma" }, deps))
    assert.equal(r.ok, false)
    assert.equal(files.stack, yaml, `${failAt}: the file is put back`)
    assert.equal(files.previous, "OLDER", `${failAt}: the earlier rollback point is put back`)
  }
}

// Managed HTTPS (#12).
// Test-only key pair, never used outside these tests.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmDCCAT+gAwIBAgIUYOYhYMFkeUQ4Q0RAOxzcirSBGd4wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAxNDEzMDM1OFoXDTM2MTAxMTEz
MDM1OFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEO61g4E1kPxzkYles/Js58BNL6D++FdxzN32eC1CeLwE4SZ6dSZOQBfng
2Q4ulWnJxZH65n4SjI7KsG6NTa0Cj6NvMG0wHQYDVR0OBBYEFF2Up4Mneb62+Pmf
npDkGffZTDoxMB8GA1UdIwQYMBaAFF2Up4Mneb62+PmfnpDkGffZTDoxMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49
BAMCA0cAMEQCIHC2KUdsFgH6A8onVhA2bifp3IDGx5pvgBOtCK3fg7+nAiBpcyVU
IlIl41q/2OQeuSAbRKDFcYoIFNetFDA1jctRyw==
-----END CERTIFICATE-----
`
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggi4rInQMsiWd8By9
FJ/Nak9dGdfXr0TXFwA1rVZNH5GhRANCAAQ7rWDgTWQ/HORiV6z8mznwE0voP74V
3HM3fZ4LUJ4vAThJnp1Jk5AF+eDZDi6VacnFkfrmfhKMjsqwbo1NrQKP
-----END PRIVATE KEY-----
`
const OTHER_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIHDWM87Uu2frcOKM/mMp+AVB7PYi1b1sR20w1VpJEaYSoAoGCCqGSM49
AwEHoUQDQgAEwZRhsEXXLd5KSUBLLexn+5yiixhu8Lisn1PftvzixBfJW6vjeUjl
piEfWidfWTtJSQtgpTmXhjxqbn4ztXeXqg==
-----END EC PRIVATE KEY-----
`

async function testManagedHttps() {
  const tc = await import("../services/tls-config")
  const ts = await import("../services/tls-server")
  const { mkdtemp, writeFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = await mkdtemp(join(tmpdir(), "hsi-tls-"))

  // Missing file: plain HTTP as before.
  assert.deepEqual(tc.readTlsConfig(dir, 9001), { mode: "off", port: 9001, standardPorts: false, trustedProxies: [] })
  await writeFile(join(dir, "tls.json"), JSON.stringify({ mode: "proxy", port: 9001, standardPorts: false, trustedProxies: ["172.17.0.0/16", "10.0.0.5"] }))
  const trust = tc.trustProxyFn(tc.readTlsConfig(dir))
  assert.equal(trust("127.0.0.1"), true)
  assert.equal(trust("172.17.3.4"), true)
  assert.equal(trust("10.0.0.5"), true)
  assert.equal(trust("10.0.0.6"), false)
  await writeFile(join(dir, "tls.json"), "{not json")
  assert.equal(tc.readTlsConfig(dir).mode, "off", "a broken file never locks the admin out")

  // Redirects keep the host, the port and the path.
  assert.equal(ts.redirectLocation("192.168.1.48:9001", "/files?x=1", 9001, 9001), "https://192.168.1.48:9001/files?x=1")
  assert.equal(ts.redirectLocation("nas", "/", 80, 443), "https://nas/")
  assert.equal(ts.redirectLocation("nas:80", "/s/abc", 80, 443), "https://nas/s/abc")
  assert.equal(ts.redirectLocation("[::1]:9001", "/", 9001, 9001), "https://[::1]:9001/")
  assert.equal(ts.redirectLocation(undefined, "/", 9001, 9001), null)

  // A missing or mismatched certificate is not loaded.
  assert.equal(ts.loadContext(dir), null)
  await writeFile(join(dir, "server.crt"), TEST_CERT)
  await writeFile(join(dir, "server.key"), OTHER_KEY)
  assert.equal(ts.loadContext(dir), null, "a key that does not match is refused")
  await writeFile(join(dir, "server.key"), TEST_KEY)
  assert.ok(ts.loadContext(dir))

  // End to end: one port, TLS served, plain HTTP redirected.
  const { buildApp } = await import("../app")
  const ctx = ts.loadContext(dir)!
  const app = buildApp({ https: ctx })
  await app.ready()
  const servers = await ts.startHttps(app, app.server as any, { mode: "local", port: 0, standardPorts: false, trustedProxies: [] }, dir, app.log)
  const port = (servers[0]!.address() as any).port
  const plain = await fetch(`http://127.0.0.1:${port}/health`, { redirect: "manual" })
  assert.equal(plain.status, 308)
  assert.equal(plain.headers.get("location"), `https://127.0.0.1:${port}/health`)
  // Over TLS, the public authority download (/health would answer 503 here:
  // no NATS in tests).
  const https = await import("node:https")
  const get = (path: string) => new Promise<{ status: number; type: string; disposition: string; body: string }>((resolve, reject) => {
    https.get({ host: "127.0.0.1", port, path, ca: TEST_CERT }, r => {
      let body = ""
      r.setEncoding("utf8").on("data", c => { body += c }).on("end", () => resolve({
        status: r.statusCode ?? 0, type: String(r.headers["content-type"] ?? ""), disposition: String(r.headers["content-disposition"] ?? ""), body,
      }))
    }).on("error", reject)
  })
  const previousTlsDir = process.env.HSI_TLS_DIR
  process.env.HSI_TLS_DIR = dir
  try {
    assert.equal((await get("/ca.crt")).status, 404, "no authority yet")
    await writeFile(join(dir, "ca.crt"), TEST_CERT)
    const ca = await get("/ca.crt")
    assert.equal(ca.status, 200)
    assert.equal(ca.type, "application/x-x509-ca-cert")
    assert.equal(ca.disposition, 'attachment; filename="hsi-authority.crt"')
    assert.equal(ca.body, TEST_CERT)
  } finally {
    if (previousTlsDir === undefined) delete process.env.HSI_TLS_DIR
    else process.env.HSI_TLS_DIR = previousTlsDir
  }
  assert.equal((app.server as any).requestTimeout, 0, "uploads and log streams are not cut by the HTTPS server")
  for (const s of servers) s.close()

  // A taken standard port is logged, never fatal: the HSI port keeps serving.
  const net = await import("node:net")
  const held = net.createServer()
  await new Promise<void>(r => held.listen(0, "0.0.0.0", () => r()))
  const heldPort = (held.address() as any).port
  const errors: string[] = []
  const fakeLog: any = { ...app.log, error: (...a: unknown[]) => { errors.push(a.map(String).join(" ")) }, info: () => {}, warn: () => {} }
  const partial = await ts.startHttps(app, app.server as any, { mode: "local", port: 0, standardPorts: true, trustedProxies: [] }, dir, fakeLog,
    { standardPortNumbers: { https: heldPort, http: 0 } })
  assert.equal(partial.length, 2, "the main listener and the free standard port")
  assert.equal(errors.length, 1, "the taken port is logged")
  const mainPort = (partial[0]!.address() as any).port
  assert.equal((await fetch(`http://127.0.0.1:${mainPort}/x`, { redirect: "manual" })).status, 308)
  const httpPort = (partial[1]!.address() as any).port
  const toStd = await fetch(`http://127.0.0.1:${httpPort}/x`, { redirect: "manual" })
  assert.equal(toStd.headers.get("location"), `https://127.0.0.1:${heldPort}/x`, "the plain standard port redirects to the HTTPS one")
  for (const s of partial) s.close()
  held.close()

  // A peer that connects and sends nothing is dropped after the idle timeout.
  const idle = await ts.startHttps(app, app.server as any, { mode: "local", port: 0, standardPorts: false, trustedProxies: [] }, dir, app.log, { idleTimeoutMs: 100 })
  const idlePort = (idle[0]!.address() as any).port
  const closedInTime = await new Promise<boolean>(resolve => {
    const c = net.connect(idlePort, "127.0.0.1")
    const t = setTimeout(() => { c.destroy(); resolve(false) }, 3000)
    c.on("close", () => { clearTimeout(t); resolve(true) })
    c.on("error", () => {})
  })
  assert.equal(closedInTime, true, "an idle connection is closed")
  for (const s of idle) s.close()

  await app.close()
  const { rm } = await import("node:fs/promises")
  await rm(dir, { recursive: true, force: true })
}

await testManagedHttps()

async function testCertificateFallbackAndHotReload() {
  const ts = await import("../services/tls-server")
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = await mkdtemp(join(tmpdir(), "hsi-tls-fallback-"))
  const quiet: any = { error: () => {}, info: () => {}, warn: () => {} }

  // Start-up: a broken local pair makes the backend ask the worker (force) and
  // use the certificate it issued.
  await writeFile(join(dir, "tls.json"), JSON.stringify({ mode: "local", port: 9001, standardPorts: false, trustedProxies: [] }))
  await writeFile(join(dir, "server.crt"), TEST_CERT)
  await writeFile(join(dir, "server.key"), OTHER_KEY)
  const asked: unknown[][] = []
  const fixed = await ts.resolveCertificate({ mode: "local", port: 9001, standardPorts: false, trustedProxies: [] }, {
    dir, port: 9001, log: quiet,
    request: async (...a: unknown[]) => { asked.push(a); await writeFile(join(dir, "server.key"), TEST_KEY); return { renewed: true } },
  })
  assert.deepEqual(asked.map(a => [a[0], a[1]]), [["root.tls.issue", { force: true }]], "the worker is asked with force")
  assert.ok(fixed.ctx, "the reissued certificate is used")
  assert.equal(fixed.ctx!.key.toString(), TEST_KEY)
  assert.equal(fixed.lost, null)
  assert.equal(ts.certificateLostEvent(fixed.lost, new Date()), null, "nothing to report")

  // An imported certificate that cannot be loaded: the worker switches to local.
  await writeFile(join(dir, "tls.json"), JSON.stringify({ mode: "imported", port: 9001, standardPorts: false, trustedProxies: [] }))
  await writeFile(join(dir, "server.key"), OTHER_KEY)
  const switched = await ts.resolveCertificate({ mode: "imported", port: 9001, standardPorts: false, trustedProxies: [] }, {
    dir, port: 9001, log: quiet,
    request: async () => {
      await writeFile(join(dir, "tls.json"), JSON.stringify({ mode: "local", port: 9001, standardPorts: false, trustedProxies: [] }))
      await writeFile(join(dir, "server.key"), TEST_KEY)
      return { renewed: true }
    },
  })
  assert.equal(switched.cfg.mode, "local")
  assert.ok(switched.ctx)
  assert.equal(switched.lost, "imported")
  assert.match(ts.certificateLostEvent("imported", new Date())!.message, /local authority/)

  // Still broken after the worker's answer (or no answer): plain HTTP and an alert.
  await writeFile(join(dir, "server.key"), OTHER_KEY)
  const broken = await ts.resolveCertificate({ mode: "local", port: 9001, standardPorts: false, trustedProxies: [] }, {
    dir, port: 9001, log: quiet, request: async () => { throw new Error("no worker") },
  })
  assert.equal(broken.ctx, null, "plain HTTP")
  assert.equal(broken.lost, "all")
  const alert = ts.certificateLostEvent("all", new Date("2026-10-14T00:00:00Z"))!
  assert.equal(alert.type, "alert.raised")
  assert.equal(alert.severity, "critical")
  assert.equal(alert.source, "system.tls")
  assert.match(alert.message, /plain HTTP/)
  assert.equal(alert.time, "2026-10-14T00:00:00.000Z")

  // Hot reload: a mismatched pair keeps the current context and logs an
  // error; a valid pair is loaded.
  const contexts: unknown[] = []
  const errors: string[] = []
  const log: any = { error: (...a: unknown[]) => { errors.push(a.map(String).join(" ")) }, info: () => {}, warn: () => {} }
  const server: any = { setSecureContext: (c: unknown) => { contexts.push(c) } }
  await writeFile(join(dir, "server.key"), TEST_KEY)
  const watcher = ts.watchCertificate(server, dir, log, 50)
  const settle = () => new Promise(r => setTimeout(r, 300))
  try {
    await writeFile(join(dir, "server.key"), OTHER_KEY)
    await settle()
    assert.equal(contexts.length, 0, "a mismatched pair is not loaded")
    assert.ok(errors.some(e => /cannot be loaded/.test(e)), "the refusal is logged")
    await writeFile(join(dir, "server.key"), TEST_KEY)
    await settle()
    assert.equal(contexts.length, 1, "a valid pair is loaded")
  } finally {
    watcher.close()
  }
  await rm(dir, { recursive: true, force: true })
}

await testCertificateFallbackAndHotReload()

async function testTlsWatchAndOps() {
  const tw = await import("../services/tls-watch")
  const now = new Date("2026-10-13T00:00:00Z")
  const day = 24 * 3600_000
  assert.equal(tw.expiryNotice(new Date(now.getTime() + 60 * day), now, null), null)
  const n30 = tw.expiryNotice(new Date(now.getTime() + 20 * day), now, null)
  assert.equal(n30?.threshold, 30)
  assert.equal(n30?.event.severity, "warning")
  assert.match(n30!.event.message, /expires in 20 days/)
  assert.equal(tw.expiryNotice(new Date(now.getTime() + 20 * day), now, 30), null, "notified once per threshold")
  assert.equal(tw.expiryNotice(new Date(now.getTime() + 5 * day), now, 30)?.threshold, 7)
  const gone = tw.expiryNotice(new Date(now.getTime() - day), now, 7)
  assert.equal(gone?.threshold, 0)
  assert.equal(gone?.event.severity, "critical")

  const sp = await import("../services/storage-plan")
  for (const op of ["tls.enable", "tls.useLocal", "tls.import", "tls.proxy", "tls.standardPorts"]) assert.ok((sp.PLAN_OPS as readonly string[]).includes(op), op)

  // The private key of an imported certificate never reaches the audit log.
  const audited = JSON.stringify(trpcIndex.redactForAudit({ op: "tls.import", input: { cert: "CERT", key: "PRIVATE" }, fingerprint: "x" }))
  assert.ok(!audited.includes("PRIVATE"))
  const combined = "-----BEGIN CERTIFICATE-----\nCERTBODY\n-----END CERTIFICATE-----\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nKEYBASE64LINE\n-----END ENCRYPTED PRIVATE KEY-----\n"
  const red = JSON.stringify(trpcIndex.redactForAudit({ op: "tls.import", input: { cert: combined, key: "" } }))
  assert.ok(!red.includes("PRIVATE KEY-----") && !red.includes("KEYBASE64LINE"))
  assert.ok(red.includes("[REDACTED PRIVATE KEY]") && red.includes("CERTBODY"))
  const truncated = "-----BEGIN CERTIFICATE-----\nCERTBODY\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nTRUNCKEYLINE1\nTRUNCKEYLINE2\n"
  const redT = JSON.stringify(trpcIndex.redactForAudit({ cert: truncated }))
  assert.ok(!redT.includes("TRUNCKEYLINE") && redT.includes("[REDACTED PRIVATE KEY]") && redT.includes("CERTBODY"))
  const plain = "-----BEGIN CERTIFICATE-----\nCERTBODY\n-----END CERTIFICATE-----\n"
  assert.equal((trpcIndex.redactForAudit({ cert: plain }) as { cert: string }).cert, plain)

  // The expiry dedup restarts when the certificate is replaced.
  const s1 = tw.nextNotice({ fingerprint: null, last: null }, { fingerprint: "A", notAfter: new Date(now.getTime() + 20 * day) }, now)
  assert.equal(s1.notice?.threshold, 30)
  const s2 = tw.nextNotice(s1.state, { fingerprint: "A", notAfter: new Date(now.getTime() + 20 * day) }, now)
  assert.equal(s2.notice, null)
  const s3 = tw.nextNotice(s2.state, { fingerprint: "B", notAfter: new Date(now.getTime() + 20 * day) }, now)
  assert.equal(s3.notice?.threshold, 30)
}

await testTlsWatchAndOps()

async function testLongTrpcBatchPathsStillRoute() {
  const { buildApp } = await import("../app")
  const app = await buildApp()
  await app.ready()
  try {
    const names = ["notifications.list", "tls.status", "system.metrics", "container.app.list", "alert.list", "update.status", "user.preferences"]
    const path = `/trpc/${names.join(",")}`
    assert.ok(path.length > 100)
    const res = await app.inject({ method: "GET", url: `${path}?batch=1&input=%7B%7D` })
    assert.match(String(res.headers["content-type"]), /application\/json/)
    const body = JSON.parse(res.body)
    assert.ok(Array.isArray(body))
    assert.equal(body.length, names.length)
  } finally {
    await app.close()
  }
}

await testLongTrpcBatchPathsStillRoute()

async function testSensitiveCallsAreCountedInBatches() {
  const { sensitiveCalls, buildApp } = await import("../app")
  assert.deepEqual(sensitiveCalls("auth.login"), { login: 1, unlock: 0 })
  assert.deepEqual(sensitiveCalls("shareLink.unlock"), { login: 0, unlock: 1 })
  assert.deepEqual(sensitiveCalls("system.metrics,auth.login"), { login: 1, unlock: 0 })
  assert.deepEqual(sensitiveCalls("system.metrics%2Cauth.login"), { login: 1, unlock: 0 })
  assert.deepEqual(sensitiveCalls("auth.login,auth.login,shareLink.unlock,auth.login"), { login: 3, unlock: 1 })
  assert.deepEqual(sensitiveCalls("system.metrics,tls.status"), { login: 0, unlock: 0 })
  assert.deepEqual(sensitiveCalls("auth.loginHistory"), { login: 0, unlock: 0 })
  // Revealing a repository password is a credential check too.
  assert.deepEqual(sensitiveCalls("backup.password"), { login: 1, unlock: 0 })
  assert.deepEqual(sensitiveCalls("backup.passwordX"), { login: 0, unlock: 0 })
  assert.deepEqual(sensitiveCalls("xauth.login,shareLink.unlockAll"), { login: 0, unlock: 0 })

  const attempt = async (url: string, ip: string) => {
    const app = await buildApp()
    await app.ready()
    try {
      return (await app.inject({ method: "POST", url, payload: {}, remoteAddress: ip })).statusCode
    } finally {
      await app.close()
    }
  }
  const twentyOne = Array(21).fill("auth.login")
  assert.equal(await attempt("/trpc/" + twentyOne.join(",") + "?batch=1", "10.9.8.1"), 429)
  assert.equal(await attempt("/trpc/" + twentyOne.join("%2C") + "?batch=1", "10.9.8.2"), 429)
  assert.equal(await attempt("/trpc/" + [...twentyOne, "auth.login"].join(",") + ";x?batch=1", "10.9.8.3"), 429)
  // A trailing slash is not routed to tRPC at all, so nothing is executed.
  assert.equal(await attempt("/trpc/" + twentyOne.join(",") + "/?batch=1", "10.9.8.4"), 404)
  assert.equal(await attempt("/trpc/system.metrics," + twentyOne.slice(1).join(",") + ",auth.login?batch=1", "10.9.8.5"), 429)

  // A semicolon makes tRPC look up a procedure that does not exist: nothing is executed.
  assert.equal(await attempt("/trpc/auth.login;x?batch=1", "10.9.8.6"), 404)
  // The 21st plain login call from one IP is refused.
  for (const [i, suffix] of [[0, ""]] as const) {
    const app = await buildApp()
    await app.ready()
    try {
      const ip = "10.9.7." + i
      const codes: number[] = []
      for (let n = 0; n < 21; n++) codes.push((await app.inject({ method: "POST", url: "/trpc/auth.login" + suffix, payload: {}, remoteAddress: ip })).statusCode)
      assert.equal(codes[20], 429, "21st login with suffix '" + suffix + "'")
      assert.notEqual(codes[19], 429)
    } finally {
      await app.close()
    }
  }
}

await testSensitiveCallsAreCountedInBatches()

async function testBackupFindings() {
  const { backupFindings } = await import("../services/backup-status")
  const base = { configExists: true, engine: { installed: true, version: "0.19.1" }, repositories: [], plans: [] }
  const plan = (id: string, status: "success" | "failed", error?: string) => ({ id, name: id, type: "versions" as const, enabled: true, schedule: { every: "daily", minute: 0, hour: 2, weekday: 0 }, nextRun: null, progress: null, last: { start: "2026-10-20T02:00:00Z", status, error } })
  assert.deepEqual(backupFindings({ ...base, plans: [plan("a", "success")] } as any), [])
  const f = backupFindings({ ...base, plans: [plan("a", "failed", "disk full"), plan("b", "failed", "vaultwarden did not start again: port in use")] } as any)
  assert.deepEqual(f.map(x => [x.target, x.severity]), [["plan:a", "warning"], ["plan:b", "critical"]])
  const noEngine = backupFindings({ ...base, engine: { installed: false, version: "" }, plans: [plan("a", "success")] } as any)
  assert.deepEqual(noEngine.map(x => x.target), ["engine"])
  const repoFail = backupFindings({ ...base, repositories: [{ id: "r", name: "USB", type: "local", check: { every: "weekly", hour: 4, weekday: 0, day: 1, subset: "5%" }, hasPassword: true, nextCheck: null, lastCheck: { start: "x", status: "failed", error: "pack abc damaged" } }] } as any)
  assert.deepEqual(repoFail.map(x => [x.target, x.severity]), [["repository:r", "critical"]])
}

async function testBackupPlanOpsAreAdminOnlyAndRedacted() {
  const sp = await import("../services/storage-plan")
  for (const op of ["backup.plan.save", "backup.plan.remove", "backup.repository.save", "backup.repository.remove", "backup.restore"]) {
    assert.ok((sp.PLAN_OPS as readonly string[]).includes(op), op)
  }
  const { redactForAudit } = await import("../trpc/index")
  const red = JSON.stringify(redactForAudit({ op: "backup.repository.save", input: { secrets: { password: "PW1", accessKeyId: "AK1", secretAccessKey: "SK1", restPassword: "RP1", sshKeyPath: "/root/KEY1" } } }))
  for (const s of ["PW1", "AK1", "SK1", "RP1", "KEY1"]) assert.ok(!red.includes(s), s)
}

await testBackupFindings()
await testBackupPlanOpsAreAdminOnlyAndRedacted()

async function testBackupReviewFixes() {
  const { BACKUP_ALERT_SOURCE, migrateRsyncPlans } = await import("../services/backup-status")
  // Dotted like every other source: the Alerts filter and notification rules match on "backup.".
  assert.ok(BACKUP_ALERT_SOURCE.startsWith("backup.") && BACKUP_ALERT_SOURCE.split(".")[0] + "." === "backup.")

  // A wrong re-authentication is FORBIDDEN: the dashboard logs out on any 401.
  const bcrypt = (await import("bcryptjs")).default
  const { backupRouter } = await import("../trpc/routers/backup")
  const hash = await bcrypt.hash("right", 4)
  const caller = backupRouter.createCaller({ user: { userId: "u", isAdmin: true }, prisma: { user: { findUnique: async () => ({ password: hash }) }, auditLog: { create: async () => ({}) } }, req: { ip: "127.0.0.1", headers: {} } } as any)
  await assert.rejects(() => caller.password({ repository: "11111111-1111-1111-1111-111111111111", currentPassword: "wrong" }), (e: any) => e.code === "FORBIDDEN" && e.message === "Wrong password")

  // The migration retries until the worker answers, then migrates once.
  const calls: string[] = []
  let failures = 2
  const delays: number[] = []
  await migrateRsyncPlans({
    request: async (subject: string) => {
      calls.push(subject)
      if (subject === "root.backup.status") {
        if (failures-- > 0) throw new Error("no responders")
        return { configExists: false }
      }
      return { migrated: 1, skipped: [] }
    },
    rows: async () => [{ id: "x" }],
    sleep: async (ms: number) => { delays.push(ms) },
  })
  assert.deepEqual(calls, ["root.backup.status", "root.backup.status", "root.backup.status", "root.backup.migrate"])
  assert.deepEqual(delays, [1000, 2000])
  // An existing configuration stops it without a migrate call.
  const calls2: string[] = []
  await migrateRsyncPlans({ request: async (s: string) => { calls2.push(s); return { configExists: true } }, rows: async () => [], sleep: async () => {} })
  assert.deepEqual(calls2, ["root.backup.status"])
}

await testBackupReviewFixes()

async function testBcryptjs2HashesStillVerify() {
  const bcrypt = (await import("bcryptjs")).default
  // Made by bcryptjs 2.4.3: user and share link passwords stored before the upgrade.
  const v2 = "$2a$04$5n6u70nGqMd78LNkw1KklOq8DVrmIeXUSw2vSTrjZxsqTS/4WxavK"
  assert.equal(await bcrypt.compare("hsi-v2-password", v2), true)
  assert.equal(await bcrypt.compare("wrong", v2), false)
  // New hashes use the $2b$ prefix and verify the same way.
  const v3 = await bcrypt.hash("hsi-v2-password", 4)
  assert.ok(v3.startsWith("$2b$04$"))
  assert.equal(await bcrypt.compare("hsi-v2-password", v3), true)
}

await testBcryptjs2HashesStillVerify()

async function testBackupFinalFixes() {
  const { backupFindings, backupTargets } = await import("../services/backup-status")
  const base = { configExists: true, engine: { installed: true, version: "0.19.1" }, repositories: [], plans: [], migrationSkipped: [] }
  // Former rsync plans the migration skipped stay a warning until the admin dismisses them.
  assert.deepEqual(backupFindings(base as any), [])
  const skipped = backupFindings({ ...base, migrationSkipped: [{ name: "Old mirror", error: "invalid absolute backup path" }] } as any)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0]!.target, "migration")
  assert.equal(skipped[0]!.severity, "warning")
  assert.ok(skipped[0]!.message.includes("Old mirror (invalid absolute backup path)"))
  assert.ok(backupTargets(base as any).includes("migration"), "a dismissed list clears its alert")

  // An interrupted check raises no corruption alert; an interrupted run is a warning.
  const check = (error: string) => ({ id: "r", name: "USB", type: "local", check: { every: "weekly", hour: 4, weekday: 0, day: 1, subset: "5%" }, hasPassword: true, nextCheck: null, lastCheck: { start: "x", status: "failed", error } })
  assert.deepEqual(backupFindings({ ...base, repositories: [check("interrupted")] } as any), [])
  assert.equal(backupFindings({ ...base, repositories: [check("pack damaged")] } as any)[0]!.severity, "critical")
  const run = (error: string) => ({ id: "a", name: "Photos", type: "versions", enabled: true, schedule: { every: "daily", minute: 0, hour: 2, weekday: 0 }, nextRun: null, progress: null, last: { start: "x", status: "failed", error } })
  const interruptedRun = backupFindings({ ...base, plans: [run("interrupted")] } as any)
  assert.equal(interruptedRun[0]!.severity, "warning")
  assert.ok(interruptedRun[0]!.message.includes("was interrupted"))
  assert.equal(backupFindings({ ...base, plans: [run("interrupted; vaultwarden did not start again: x")] } as any)[0]!.severity, "critical")

  // A user deleted while their session lives on gets a refusal, not a server error.
  const { backupRouter } = await import("../trpc/routers/backup")
  const gone = backupRouter.createCaller({ user: { userId: "gone", isAdmin: true }, prisma: { user: { findUnique: async () => null }, auditLog: { create: async () => ({}) } }, req: { ip: "127.0.0.1", headers: {} } } as any)
  await assert.rejects(() => gone.password({ repository: "11111111-1111-1111-1111-111111111111", currentPassword: "x" }), (e: any) => e.code === "FORBIDDEN")

  // backup.* and tls.* plan operations are for admins only, even with the storage capability.
  const { storageRouter } = await import("../trpc/routers/storage")
  const member = storageRouter.createCaller({ user: { userId: "m", isAdmin: false, capabilities: ["storage"] }, prisma: { auditLog: { create: async () => ({}) } }, req: { ip: "127.0.0.1", headers: {} } } as any)
  for (const op of ["backup.plan.save", "backup.plan.remove", "backup.repository.save", "backup.repository.remove", "backup.restore", "tls.enable"] as const) {
    await assert.rejects(() => member.plan({ op, input: {} }), (e: any) => e.code === "FORBIDDEN", op)
    await assert.rejects(() => member.execute({ op, input: {}, fingerprint: "f" }), (e: any) => e.code === "FORBIDDEN", op)
  }

  // The worker's refusal code reaches the dashboard in the error data.
  const { workerErrorCode, router, publicProcedure } = await import("../trpc/index")
  const { TRPCError } = await import("@trpc/server")
  const r = router({ fail: publicProcedure.mutation(() => { throw Object.assign(new Error("This replaces 2 files"), { code: "ECONFIRM" }) }) })
  const err = await r.createCaller({} as any).fail().then(() => null, (e: unknown) => e as InstanceType<typeof TRPCError>)
  assert.ok(err)
  assert.equal(workerErrorCode(err), "ECONFIRM")
  const shape = (r as any)._def._config.errorFormatter({ shape: { message: err.message, code: -32603, data: { code: "INTERNAL_SERVER_ERROR" } }, error: err, type: "mutation", path: "fail", input: undefined, ctx: {} })
  assert.equal(shape.data.workerCode, "ECONFIRM")
  assert.equal(workerErrorCode(new TRPCError({ code: "BAD_REQUEST", cause: Object.assign(new Error("x"), { code: "not a code" }) })), undefined)

  // A mutation is audited with its path, the target read from its raw input and the redacted input.
  const { adminProcedure } = await import("../trpc/index")
  const z = (await import("zod")).z
  const logged: any[] = []
  const audited = router({ mount: adminProcedure.input(z.object({ device: z.string(), password: z.string() })).mutation(() => "ok") })
  await audited.createCaller({ user: { userId: "u", isAdmin: true }, prisma: { auditLog: { create: async ({ data }: any) => { logged.push(data); return {} } } }, req: { ip: "127.0.0.1", headers: {} } } as any)
    .mount({ device: "sdb1", password: "hunter2" })
  assert.equal(logged.length, 1)
  assert.equal(logged[0].action, "mount")
  assert.equal(logged[0].target, "sdb1")
  assert.ok(logged[0].meta.includes("sdb1") && !logged[0].meta.includes("hunter2"))
}

await testBackupFinalFixes()


async function testTelemetryChannelOptOutAndPayload() {
  const { telemetryChannel, getTelemetryStatus, setTelemetryEnabled, firstHeartbeatDelay } = await import("../services/telemetry")
  const prod = { NODE_ENV: "production" }
  assert.equal(telemetryChannel("v1.71.0", prod), "stable")
  assert.equal(telemetryChannel("v1.72.0-rc.1", prod), "beta")
  assert.equal(telemetryChannel("v1.71.0", {}), "dev", "not production")
  assert.equal(telemetryChannel("v0.0.0", prod), "dev", "source checkout without a version")
  assert.equal(telemetryChannel("v1.71.0", { ...prod, HSI_TELEMETRY_CHANNEL: "Beta" }), "beta")
  assert.equal(telemetryChannel("v1.71.0", { HSI_TELEMETRY_CHANNEL: "stable" }), "stable")
  assert.equal(telemetryChannel("v1.71.0", { ...prod, HSI_TELEMETRY_CHANNEL: "nightly" }), "stable", "unknown override ignored")

  const dir = await mkdtemp(join(tmpdir(), "hsi-telemetry-test-"))
  try {
    const on = await getTelemetryStatus(dir, prod)
    assert.equal(on.enabled, true)
    assert.equal(on.payload.schema_version, 2)
    assert.equal(on.payload.channel, "stable")
    assert.match(on.payload.installation_id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(Object.keys(on.payload).sort(), ["channel", "hsi", "installation_id", "schema_version", "system"])
    assert.equal((await getTelemetryStatus(dir, prod)).payload.installation_id, on.payload.installation_id, "stable id")

    await setTelemetryEnabled(false, dir)
    assert.deepEqual([(await getTelemetryStatus(dir, prod)).enabled, (await getTelemetryStatus(dir, prod)).disabledBy], [false, "settings"])
    await setTelemetryEnabled(true, dir)
    const envOff = await getTelemetryStatus(dir, { ...prod, HSI_TELEMETRY_ENABLED: "false" })
    assert.deepEqual([envOff.enabled, envOff.disabledBy], [false, "environment"], "the environment wins over Settings")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  assert.equal(firstHeartbeatDelay(() => 0), 0)
  assert.ok(firstHeartbeatDelay(() => 0.999) < 60 * 60 * 1000)
}
await testTelemetryChannelOptOutAndPayload()

// Maintenance (#132): an update, a restart or a reboot blocks mutations until
// a new backend answers, or until it clearly never will.
{
  const m = await import("../services/maintenance")
  const t0 = new Date("2026-10-29T10:00:00.000Z")
  const at = (min: number) => new Date(t0.getTime() + min * 60_000)
  const update = { kind: "update" as const, target: "v1.73.0", since: t0.toISOString() }
  const result = (o: object) => ({ from: "v1.72.0", to: "v1.73.0", status: "refused", step: "verify", reason: "x", at: at(1).toISOString(), ...o })
  assert.ok(m.maintenanceHolds(update, at(10), null), "an update holds while the old backend runs")
  assert.ok(!m.maintenanceHolds(update, at(61), null), "an update that never restarted HSI expires")
  assert.ok(!m.maintenanceHolds(update, at(2), result({})), "refused before any restart: over")
  assert.ok(m.maintenanceHolds(update, at(2), result({ at: at(-5).toISOString() })), "an older result does not end it")
  assert.ok(m.maintenanceHolds(update, at(2), result({ to: "v1.71.0" })), "a result for another version does not end it")
  assert.ok(!m.maintenanceHolds({ kind: "restart", target: null, since: t0.toISOString() }, at(6), null), "a restart that never came expires")
  assert.ok(m.maintenanceHolds({ kind: "reboot", target: null, since: t0.toISOString() }, at(10), null))

  m.resetMaintenance()
  assert.equal(await m.currentMaintenance(), null, "a fresh backend is not in maintenance")
  m.beginMaintenance("restart")
  assert.equal((await m.currentMaintenance())?.kind, "restart")

  const { router, protectedProcedure } = await import("../trpc/index")
  const r = router({ change: protectedProcedure.mutation(() => "done"), read: protectedProcedure.query(() => "ok") })
  const caller = r.createCaller({ user: { userId: "u", isAdmin: false }, prisma: { auditLog: { create: async () => ({}) } }, req: { ip: "127.0.0.1", headers: {} } } as any)
  await assert.rejects(() => caller.change(), (e: any) => e.code === "SERVICE_UNAVAILABLE", "mutations are refused")
  assert.equal(await caller.read(), "ok", "queries stay open")
  m.resetMaintenance()
  assert.equal(await caller.change(), "done")
}
// App Store catalog (#26): every manifest file is in the catalog under its
// file name, with an icon, so an app added without registering it, or with
// a stray icon, fails here instead of silently missing from the store.
{
  const { CATALOG } = await import("@app/app-catalog")
  const { readdirSync } = await import("node:fs")
  const dir = new URL("../../../../packages/app-catalog/", import.meta.url)
  const files = readdirSync(new URL("apps/", dir)).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort()
  const icons = readdirSync(new URL("icons/", dir)).filter(f => f.endsWith(".svg")).map(f => f.slice(0, -4)).sort()
  const ids = CATALOG.map(m => m.id).sort()
  assert.deepEqual(ids, files, "every apps/<id>.json is registered in the catalog, under its file name")
  assert.deepEqual(icons, ids, "every app has icons/<id>.svg, and every icon an app")
  for (const m of CATALOG) {
    assert.ok(/^<svg[\s>]/.test(m.icon.trim()) && m.icon.includes("viewBox"), `${m.id}: the icon is an <svg> with a viewBox`)
    assert.ok(!/<script|\son[a-z]+=/i.test(m.icon), `${m.id}: the icon carries no script`)
  }
  assert.equal(new Set(CATALOG.map(m => m.name.toLowerCase())).size, CATALOG.length, "app names are unique")
}
// Access tokens and the MCP endpoint (#138): a token narrows its user's rights,
// never reaches tokens, passwords or setup, and every action it makes is
// recorded as coming from an assistant.
{
  const t = await import("../services/api-tokens")
  const { secret, hash, prefix } = t.newTokenSecret()
  assert.ok(secret.startsWith("hsi_pat_") && secret.length > 40, "a token is long and recognisable")
  assert.equal(hash, t.hashToken(secret))
  assert.ok(secret.startsWith(prefix) && prefix.length === 12, "only the start of the secret is kept for the list")
  assert.deepEqual(t.parseScopes('["files:read","root:all","apps:write"]'), ["files:read", "apps:write"], "unknown scopes are dropped")
  assert.deepEqual(t.parseScopes("not json"), [])
  assert.ok(t.DEFAULT_SCOPES.every(s => s.endsWith(":read")), "a new token is read-only by default")
  const now = new Date("2026-10-29T12:00:00Z")
  assert.ok(t.tokenUsable({ revokedAt: null, expiresAt: null }, now))
  assert.ok(!t.tokenUsable({ revokedAt: now, expiresAt: null }, now), "a revoked token stops at once")
  assert.ok(!t.tokenUsable({ revokedAt: null, expiresAt: new Date("2026-10-29T11:59:59Z") }, now), "an expired token stops")
  assert.equal(await t.authenticateApiToken("Bearer eyJhbGciOi.session.jwt"), null, "a session JWT is not an access token")
  assert.equal(await t.authenticateApiToken(undefined), null)

  const { router, protectedProcedure, closedToApiTokens } = await import("../trpc/index")
  for (const p of ["apiToken.create", "apiToken.revoke", "user.changePassword", "auth.logout", "setup.createAdmin"]) {
    assert.ok(closedToApiTokens(p), `${p} is closed to tokens`)
  }
  assert.ok(!closedToApiTokens("fs.list") && !closedToApiTokens("user.list"))
  const logged: Array<Record<string, unknown>> = []
  const r = router({
    apiToken: router({ create: protectedProcedure.mutation(() => "made") }),
    fs: router({ mkdir: protectedProcedure.input((v: unknown) => v as { path: string }).mutation(() => "done") }),
  })
  const ctx = (apiToken: { id: string; scopes: string[] } | null) => ({
    user: { userId: "u1", isAdmin: true }, via: apiToken ? "mcp" : "dashboard", apiToken, audit: {},
    prisma: { auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { logged.push(data); return {} } } },
    req: { ip: "127.0.0.1", headers: {} },
  }) as any
  await assert.rejects(() => r.createCaller(ctx({ id: "tok1", scopes: [] })).apiToken.create(), (e: any) => e.code === "FORBIDDEN", "a token cannot make tokens")
  assert.equal(await r.createCaller(ctx(null)).apiToken.create(), "made", "a signed-in session can")
  await r.createCaller(ctx({ id: "tok1", scopes: ["files:write"] })).fs.mkdir({ path: "/srv/a" })
  await new Promise(res => setImmediate(res))
  const entry = logged.find(l => l.action === "fs.mkdir")
  assert.equal(entry?.via, "mcp", "the audit log says the action came from an assistant")
  assert.equal(entry?.tokenId, "tok1", "and with which token")

  const tools = await import("../mcp/tools")
  const user = (scopes: string[], over: object = {}) => ({
    userId: "u1", jti: "pat:x", isAdmin: false, isUserManager: false, mustChangePassword: false, capabilities: [] as string[],
    apiToken: { id: "x", scopes }, ...over,
  }) as any
  const byName = (n: string) => tools.READ_TOOLS.find(x => x.name === n)!
  assert.ok(tools.toolAllowed(byName("list_files"), user(["files:read"])))
  assert.ok(!tools.toolAllowed(byName("list_files"), user(["apps:read"])), "no scope, no tool")
  assert.ok(!tools.toolAllowed(byName("list_apps"), user(["apps:read"])), "an admin tool is hidden from a user")
  assert.ok(tools.toolAllowed(byName("list_apps"), user(["apps:read"], { isAdmin: true })))
  assert.ok(tools.toolAllowed(byName("storage_overview"), user(["storage:read"], { capabilities: ["storage"] })), "the storage capability opens storage tools")
  assert.equal(new Set(tools.READ_TOOLS.map(x => x.name)).size, tools.READ_TOOLS.length, "tool names are unique")
  assert.ok(tools.READ_TOOLS.every(x => x.scope?.endsWith(":read")), "read tools need read scopes only")
  const cut = tools.truncateText("x".repeat(10), 4)
  assert.deepEqual(cut, { content: "xxxx", truncated: true, totalChars: 10 })
  const shown = tools.appForAssistant({
    rawYaml: "services:\n  db:\n    image: postgres:17\n    environment:\n      POSTGRES_PASSWORD: s3cret\n",
    services: [{ name: "db", environment: [{ key: "POSTGRES_PASSWORD", value: "s3cret" }, { key: "TZ", value: "UTC" }] }],
  })
  assert.ok(!JSON.stringify(shown).includes("s3cret"), "an app's secrets never reach the assistant")
  assert.ok(JSON.stringify(shown).includes("UTC"))
  // Shaped like listStacks(): secrets can sit in the app's settings, unknown
  // compose fields and Docker's view as well.
  const stack = tools.appForAssistant({
    name: "db", rawYaml: "services:\n  db:\n    environment:\n      - API_TOKEN=t0ken\n",
    app: { envs: [{ key: "DB_PASSWORD", value: "hunter2" }], secretKey: "k3y" },
    unknownFields: { "x-hsi": { password: "pw1" } },
    observed: [{ name: "db", env: [{ key: "SMTP_PASS", value: "pw2" }] }],
    services: [],
  })
  for (const leak of ["t0ken", "hunter2", "k3y", "pw1", "pw2"]) {
    assert.ok(!JSON.stringify(stack).includes(leak), `${leak} is masked everywhere in an app`)
  }
  assert.equal(stack.name, "db")

  const Fastify = (await import("fastify")).default
  const rateLimit = (await import("@fastify/rate-limit")).default
  const { mcpRoutes } = await import("../mcp/route")
  const app = Fastify()
  await app.register(rateLimit, { max: 2000, timeWindow: "1 minute" })
  await app.register(mcpRoutes)
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }
  const anon = await app.inject({ method: "POST", url: "/mcp", payload: init })
  assert.equal(anon.statusCode, 401, "no token, no MCP")
  assert.match(String(anon.headers["www-authenticate"]), /^Bearer/)
  const jwt = await app.inject({ method: "POST", url: "/mcp", payload: init, headers: { authorization: "Bearer " + signToken("u1", true, true, [], false) } })
  assert.equal(jwt.statusCode, 401, "a dashboard session is not accepted on /mcp")
  assert.equal((await app.inject({ method: "GET", url: "/mcp" })).statusCode, 405)
  await app.close()

  // Changes (#138): reversible ones run, the rest is queued for approval, and
  // a plan is queued only as it was previewed.
  const w = await import("../mcp/write-tools")
  const aa = await import("../services/agent-actions")
  const all = [...tools.READ_TOOLS, ...w.WRITE_TOOLS, w.CHECK_TOOL]
  assert.equal(new Set(all.map(x => x.name)).size, all.length, "every MCP tool has its own name")
  assert.ok(w.WRITE_TOOLS.every(x => x.scope?.endsWith(":write")), "changing tools need a change scope")
  assert.ok(closedToApiTokens("agentAction.approve"), "an assistant never approves its own requests")
  const queued: Array<Record<string, any>> = []
  const fakeCtx = (caller: object, scopes = ["files:write", "apps:write", "storage:write", "users:write"]) => ({
    caller, user: user(scopes, { isAdmin: true }), auditRead: () => {},
    queue: async (c: Record<string, any>) => { queued.push(c); return { requestId: "r1", status: "pending" as const, message: "" } },
    checkRequest: async () => null,
  }) as any
  const tw = (n: string) => w.WRITE_TOOLS.find(x => x.name === n)!
  const stamp = { type: "file", size: 3, mtime: "2026-10-29T10:00:00Z", ctime: "2026-10-29T10:00:00Z", uid: 1000 }
  const files = { fs: { stat: async ({ path }: { path: string }) => ({ path, ...stamp }) } }
  const del = await tw("delete_files").run({ paths: ["/srv/a/x.txt"], reason: "duplicate" } as never, fakeCtx(files)) as any
  assert.equal(del.status, "pending", "a deletion waits for approval")
  assert.equal(queued.at(-1)!.procedure, "fs.delete")
  assert.ok(queued.at(-1)!.destructive)
  assert.ok(aa.isQueueable("fs.delete") && !aa.isQueueable("fs.chmod") && !aa.isQueueable("update.rebootHost"), "only listed procedures can be queued")
  // Approved as previewed: another object put at the path since (a rename
  // updates its ctime) is not deleted, and nothing is.
  const deleted: string[] = []
  const later = (ctime: string) => ({ fs: { stat: async () => ({ ...stamp, ctime }), delete: async ({ path }: { path: string }) => { deleted.push(path); return { jobId: "j" } } } }) as any
  await assert.rejects(() => aa.APPROVAL_PROCEDURES["fs.delete"](later("2026-10-29T11:00:00Z"), queued.at(-1)!.input),
    (e: any) => e.code === "CONFLICT", "a path that changed since the request is not deleted")
  assert.deepEqual(deleted, [])
  await aa.APPROVAL_PROCEDURES["fs.delete"](later(stamp.ctime), queued.at(-1)!.input)
  assert.deepEqual(deleted, ["/srv/a/x.txt"], "an unchanged path is deleted once approved")
  await assert.rejects(() => tw("write_text_file").run({ path: "/srv/a/x.txt", content: "y".repeat(aa.MAX_OVERWRITE_CHARS + 1), overwrite: true } as never, fakeCtx(files)),
    (e: any) => e.code === "BAD_REQUEST", "a replacement too long to read in full is not queued")
  await assert.rejects(() => tw("write_text_file").run({ path: "/srv/a/x.txt", content: "new", overwrite: false } as never, fakeCtx(files)),
    (e: any) => e.code === "CONFLICT", "an existing file is not replaced without asking")
  await tw("write_text_file").run({ path: "/srv/a/x.txt", content: "new", overwrite: true } as never, fakeCtx(files))
  assert.equal(queued.at(-1)!.procedure, "fs.writeText", "replacing a file waits for approval")
  assert.equal(queued.at(-1)!.preview.content, "new", "the whole new content is shown for approval")
  const apps = { apps: { plan: async () => ({ steps: [{ summary: "remove", destructive: true }], fingerprint: "fp-now" }) } }
  await assert.rejects(() => tw("request_app_change").run({ op: "app.remove", input: { name: "web" }, fingerprint: "fp-old" } as never, fakeCtx(apps)),
    (e: any) => e.code === "CONFLICT", "a plan that changed since its preview is not queued")
  await tw("request_app_change").run({ op: "app.remove", input: { name: "web" }, fingerprint: "fp-now" } as never, fakeCtx(apps))
  assert.deepEqual(queued.at(-1)!.input, { op: "app.remove", input: { name: "web" }, fingerprint: "fp-now" }, "exactly the previewed plan is queued")
  assert.equal(queued.at(-1)!.procedure, "apps.execute")
  const storage = { storage: { plan: async () => ({ steps: [], fingerprint: "f" }) } }
  await assert.rejects(() => tw("preview_storage_change").run({ op: "network.ipv4", input: {} } as never, fakeCtx(storage, ["storage:write"])),
    (e: any) => e.code === "FORBIDDEN", "network settings need the system scope")
  assert.ok(tools.toolAllowed(tw("preview_storage_change"), user(["system:write"], { isAdmin: true })), "network changes are offered with the system scope alone")
  assert.ok(!tools.toolAllowed(tw("preview_storage_change"), user(["storage:read"], { isAdmin: true })))
  assert.ok(aa.decidable({ status: "pending", expiresAt: new Date(Date.now() + 1000) }))
  assert.ok(!aa.decidable({ status: "pending", expiresAt: new Date(Date.now() - 1000) }), "an expired request cannot be approved")
  assert.ok(!aa.decidable({ status: "done", expiresAt: new Date(Date.now() + 1000) }), "nor one decided already")
  assert.deepEqual(aa.outcome({ ok: false, error: "step 2 failed" }), { ok: false, error: "step 2 failed" }, "a plan with a failed step is a failure")
  assert.deepEqual(aa.outcome({ jobId: "x" }), { ok: true })

  // The protocol itself, with a token whose user and scopes are given.
  const mcp = Fastify()
  await mcp.register(rateLimit, { max: 2000, timeWindow: "1 minute" })
  await mcp.register(mcpRoutes, {
    authenticate: async (h?: string) => h === "Bearer hsi_pat_test" ? user(["files:read", "system:read"]) : null,
    exclusions: async () => ({ ids: new Set(), paths: [] }),
  })
  const rpc = async (body: object) => {
    const res = await mcp.inject({
      method: "POST", url: "/mcp", payload: body,
      headers: { authorization: "Bearer hsi_pat_test", accept: "application/json, text/event-stream" },
    })
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  const hello = await rpc(init)
  assert.equal(hello.result.serverInfo.name, "hsi")
  assert.ok(hello.result.capabilities.tools, "the server offers tools")
  const listed = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).result.tools.map((x: { name: string }) => x.name)
  assert.ok(listed.includes("list_files") && listed.includes("system_metrics"), "the token's scopes give their tools")
  assert.ok(!listed.includes("list_apps") && !listed.includes("system_info"), "tools beyond the scopes or the user's rights are not offered")
  const unknown = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_apps", arguments: {} } })
  assert.ok(unknown.error || unknown.result?.isError, "a tool that is not offered cannot be called")
  await mcp.close()
}

// The built-in assistant: a chat in the dashboard, with the MCP tools, as the
// signed-in account. Its provider speaks the OpenAI-compatible API.
{
  const prov = await import("../services/assistant-provider")
  const chat = await import("../assistant/chat")
  const { ALL_TOOLS } = await import("../mcp/context")
  const settings = await import("../services/assistant-settings")
  const { closedToApiTokens, router, protectedProcedure } = await import("../trpc/index")

  // The stream: text in pieces, a tool call whose arguments come in parts,
  // a comment line (OpenRouter's keep-alive) and [DONE].
  const lines = [
    ": OPENROUTER PROCESSING",
    'data: {"choices":[{"delta":{"content":"Let me "}}]}',
    'data: {"choices":[{"delta":{"content":"check."}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_files","arguments":"{\\"path\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/srv/a\\"}"}}]},"finish_reason":"tool_calls"}]}',
    "data: [DONE]",
  ]
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const text = new TextEncoder().encode(lines.join("\n") + "\n")
      // Cut mid-line, as a network would.
      c.enqueue(text.subarray(0, 50)); c.enqueue(text.subarray(50)); c.close()
    },
  })
  const deltas: string[] = []
  const reply = await prov.collectStream(prov.sseData(body), d => deltas.push(d))
  assert.equal(reply.content, "Let me check.")
  assert.deepEqual(deltas, ["Let me ", "check."], "text is passed on as it comes")
  assert.deepEqual(reply.toolCalls, [{ id: "call_1", name: "list_files", arguments: '{"path":"/srv/a"}' }], "a tool call is put back together")
  assert.equal(reply.finishReason, "tool_calls")
  await assert.rejects(() => prov.collectStream((async function* () { yield '{"error":{"message":"rate limited"}}' })(), () => {}), /rate limited/,
    "an error in the stream stops the turn")

  // Every tool the chat offers has a JSON Schema the model can read.
  const admin = chat.chatUser({ userId: "u1", jti: "j", isAdmin: true, isUserManager: true, mustChangePassword: false, capabilities: [] })
  const adminTools = chat.chatTools(ALL_TOOLS, admin)
  const defs = adminTools.defs
  const everything = adminTools.offered(new Set(Object.keys(chat.TOOL_FAMILIES)))
  assert.equal(defs.size, ALL_TOOLS.length, "an admin gets every tool")
  assert.equal(everything.length, ALL_TOOLS.length + 1, "every tool, and load_tools")
  assert.ok(everything.every(t => (t.function.parameters as { type?: string }).type === "object"), "each tool takes an object")

  // Families: only load_tools (and check_request) at first, then what was asked for.
  const first = adminTools.offered(new Set())
  assert.deepEqual(first.map(t => t.function.name).sort(), ["check_request", "load_tools"])
  assert.ok(JSON.stringify(first).length * 5 < JSON.stringify(everything).length, "the first call sends a fraction of the definitions")
  const loaded = new Set<string>()
  const answer = chat.loadFamilies('{"families":["files","nope"]}', adminTools.families, loaded)
  assert.ok(answer.ok && loaded.has("files") && answer.content.includes("nope"), "an unknown family is reported, the known ones load")
  const withFiles = adminTools.offered(loaded).map(t => t.function.name)
  assert.ok(withFiles.includes("list_files") && withFiles.includes("delete_files") && !withFiles.includes("list_apps"))
  assert.ok(!chat.loadFamilies("{}", adminTools.families, new Set()).ok)
  assert.deepEqual([...chat.familiesUsed(["list_apps", "check_request", null, "gone"], defs)], ["apps"], "a conversation keeps the families it used")
  assert.deepEqual(adminTools.families, ["files", "apps", "storage", "users", "system"])
  const plain = chat.chatTools(ALL_TOOLS, chat.chatUser({ userId: "u2", jti: "j", isAdmin: false, isUserManager: false, mustChangePassword: false, capabilities: [] }))
  assert.ok(plain.defs.has("read_text_file") && !plain.defs.has("list_apps") && !plain.defs.has("preview_storage_change"),
    "a user only gets the tools of their own rights")
  for (const p of ["assistant.saveSettings", "assistant.settings", "agentAction.approve", "apiToken.create"]) {
    assert.ok(closedToApiTokens(p), `${p} is closed to assistants`)
  }
  const r = router({ assistant: router({ saveSettings: protectedProcedure.mutation(() => "saved") }), fs: router({ list: protectedProcedure.query(() => "files") }) })
  const ctx = (via: string) => ({
    user: { userId: "u1", isAdmin: true }, via, apiToken: null, audit: {},
    prisma: { auditLog: { create: async () => ({}) } }, req: { ip: "127.0.0.1", headers: {} },
  }) as any
  await assert.rejects(() => r.createCaller(ctx("assistant")).assistant.saveSettings(), (e: any) => e.code === "FORBIDDEN",
    "the chat's tools can never change the assistant's settings")
  assert.equal(await r.createCaller(ctx("assistant")).fs.list(), "files")
  assert.equal(await r.createCaller(ctx("dashboard")).assistant.saveSettings(), "saved")

  // Arguments are checked before a tool runs; a queued change is flagged.
  const ran: unknown[] = []
  const run = async (_d: unknown, args: unknown) => { ran.push(args); return { requestId: "a1", status: "pending" } }
  const err = (e: unknown) => ({ error: String(e) })
  assert.match((await chat.runToolCall({ id: "1", name: "nope", arguments: "{}" }, defs, run, err)).content, /Unknown tool/)
  assert.match((await chat.runToolCall({ id: "1", name: "list_files", arguments: "{not json" }, defs, run, err)).content, /not valid JSON/)
  assert.match((await chat.runToolCall({ id: "1", name: "list_files", arguments: '{"path":3}' }, defs, run, err)).content, /Invalid arguments/)
  assert.equal(ran.length, 0, "no tool runs with bad arguments")
  const ok = await chat.runToolCall({ id: "1", name: "list_files", arguments: '{"path":"/srv/a"}' }, defs, run, err)
  assert.deepEqual(ok, { ok: true, content: '{"requestId":"a1","status":"pending"}', approvalId: "a1" })
  const failed = await chat.runToolCall({ id: "1", name: "list_files", arguments: '{"path":"/srv/a"}' }, defs, async () => { throw new Error("EACCES") }, err)
  assert.equal(failed.ok, false)

  // A turn: the model calls a tool, reads its result, then answers.
  const replies = [
    { content: "", toolCalls: [{ id: "c1", name: "list_files", arguments: '{"path":"/srv/a"}' }], finishReason: "tool_calls", usage: 120 },
    { content: "There are 2 files.", toolCalls: [], finishReason: "stop", usage: null },
  ]
  const seen: number[] = []
  const saved: Array<{ role: string; content: string }> = []
  const events: Array<{ type: string }> = []
  await chat.runTurn("sys", [{ role: "user", content: "what is in /srv/a?" }], {
    stream: async (messages, _tools, onText) => { seen.push(messages.length); const r = replies.shift()!; if (r.content) onText(r.content); return r },
    runTool: async () => ({ ok: true, content: "x".repeat(chat.MAX_TOOL_CHARS + 10) }),
    save: async m => { saved.push(m) },
    emit: e => { events.push(e) },
    aborted: () => false,
  })
  assert.deepEqual(seen, [2, 4], "the model sees the tool's result before answering")
  assert.deepEqual(saved.map(m => m.role), ["assistant", "tool", "assistant"])
  assert.ok(saved[1]!.content.length < chat.MAX_TOOL_CHARS + 200 && saved[1]!.content.includes("[cut:"), "a large result is cut")
  assert.deepEqual(events.map(e => e.type), ["tool", "toolResult", "text"])
  // A model that never stops calling tools is stopped.
  const loop: Array<{ type: string }> = []
  let calls = 0
  await chat.runTurn("sys", [], {
    stream: async () => { calls++; return { content: "", toolCalls: [{ id: `c${calls}`, name: "list_places", arguments: "{}" }], finishReason: "tool_calls", usage: null } },
    runTool: async () => ({ ok: true, content: "[]" }), save: async () => {}, emit: e => { loop.push(e) }, aborted: () => false,
  })
  assert.equal(calls, chat.MAX_ROUNDS)
  assert.equal(loop.at(-1)!.type, "error")

  // Tokens: as reported, or estimated; the daily limit stops before running tools.
  const counted: number[] = []
  const limited: Array<{ role: string; content: string }> = []
  const limitEvents: Array<{ type: string }> = []
  let toolRuns = 0
  await chat.runTurn("sys", [{ role: "user", content: "hi" }], {
    stream: async () => ({ content: "", toolCalls: [{ id: "c1", name: "list_places", arguments: "{}" }], finishReason: "tool_calls", usage: null }),
    runTool: async () => { toolRuns++; return { ok: true, content: "[]" } },
    save: async m => { limited.push(m) }, emit: e => { limitEvents.push(e) }, aborted: () => false,
    tools: () => everything,
    used: async t => { counted.push(t); return false },
  })
  assert.ok(counted[0]! > 1000, "an unreported call is estimated, tool definitions included")
  assert.equal(toolRuns, 0, "no tool runs once the limit is reached")
  assert.deepEqual(limited.map(m => m.role), ["assistant", "tool"], "the call is answered, so the history stays valid")
  assert.equal(limitEvents.at(-1)!.type, "error")
  assert.equal(chat.callTokens([], 0, { content: "", toolCalls: [], finishReason: "stop", usage: 42 }), 42, "a reported count is used as is")

  // Stopped while writing: the text so far is kept.
  const kept: Array<{ role: string; content: string }> = []
  let stopped = false
  await chat.runTurn("sys", [{ role: "user", content: "hi" }], {
    stream: async (_m, _t, onText) => { onText("Half an "); onText("answer"); stopped = true; throw new DOMException("aborted", "AbortError") },
    runTool: async () => ({ ok: true, content: "" }), save: async m => { kept.push(m) }, emit: () => {}, aborted: () => stopped,
  })
  assert.deepEqual(kept, [{ role: "assistant", content: "Half an answer" }])

  // Read-only: only the tools that read.
  const ro = chat.chatTools(ALL_TOOLS, admin, true)
  assert.ok(ro.defs.has("list_files") && ro.defs.has("storage_overview"))
  assert.ok(!ro.offered(new Set()).some(t => t.function.name === "check_request"), "nothing to check in read-only mode")
  assert.ok(![...ro.defs.keys()].some(n => /^(create_|write_|delete_|rename|move|copy|request_|preview_|start_|stop_|restart_|run_|check_)/.test(n)),
    "nothing that changes anything is offered")
  assert.match(chat.systemPrompt({ username: "a", isAdmin: true, version: "v", now: new Date(), readOnly: true }), /read-only/)

  // A busy or unreachable provider is tried again; a refused request is not.
  let tries = 0
  const ctl = new AbortController()
  assert.equal(await prov.withRetries(async () => { if (++tries < 3) throw new prov.ProviderError("busy", 429); return "ok" }, ctl.signal, [1, 1]), "ok")
  assert.equal(tries, 3)
  tries = 0
  await assert.rejects(() => prov.withRetries(async () => { tries++; throw new prov.ProviderError("bad key", 401) }, ctl.signal, [1, 1]), /bad key/)
  assert.equal(tries, 1, "a refused key is not tried again")
  assert.ok(prov.retryable(new TypeError("fetch failed")) && prov.retryable(new prov.ProviderError("x", 503)))
  assert.ok(!prov.retryable(Object.assign(new prov.ProviderError("x", 503), { noRetry: true })), "nor a call that already sent text")
  const usageReply = await prov.collectStream((async function* () {
    yield '{"choices":[{"delta":{"content":"hi"}}]}'
    yield '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
  })(), () => {})
  assert.equal(usageReply.usage, 15, "the usage chunk at the end is read")

  // The history the model reads starts with the user, without dangling calls.
  const history = chat.historyForModel([
    { role: "tool", content: "orphan", toolCalls: null, toolCallId: "c0" },
    { role: "user", content: "hi", toolCalls: null, toolCallId: null },
    { role: "assistant", content: "", toolCalls: JSON.stringify([{ id: "c1", name: "x", arguments: "{}" }, { id: "c2", name: "y", arguments: "{}" }]), toolCallId: null },
    { role: "tool", content: "r1", toolCalls: null, toolCallId: "c1" },
    { role: "event", content: "The user approved it.", toolCalls: null, toolCallId: null },
  ])
  assert.equal(history[0]!.role, "user", "a cut-off tool result is not sent")
  assert.deepEqual((history[1] as any).tool_calls.map((c: any) => c.id), ["c1"], "a call that has no result is not sent")
  assert.deepEqual(history[3], { role: "user", content: "[HSI] The user approved it." }, "a decision reaches the model as a note")
  const raced = chat.historyForModel([
    { role: "user", content: "delete x", toolCalls: null, toolCallId: null },
    { role: "assistant", content: "", toolCalls: JSON.stringify([{ id: "c1", name: "delete_files", arguments: "{}" }]), toolCallId: null },
    { role: "event", content: "The user approved it.", toolCalls: null, toolCallId: null },
    { role: "tool", content: "pending", toolCalls: null, toolCallId: "c1" },
  ])
  assert.deepEqual(raced.map(m => m.role), ["user", "assistant", "tool", "user"], "a decision noted before the call's result comes after it")

  const { decisionNote } = await import("../services/agent-actions")
  assert.match(decisionNote({ title: "Delete 1 file", status: "done", error: null, result: '{"jobId":"j"}' }), /approved .* ran successfully/)
  assert.match(decisionNote({ title: "Delete 1 file", status: "rejected", error: null, result: null }), /rejected/)
  assert.match(decisionNote({ title: "x", status: "failed", error: "disk full", result: null }), /failed: disk full/)
  assert.equal(chat.titleOf("  Clean   up\nmy downloads "), "Clean up my downloads")
  assert.ok(chat.titleOf("x".repeat(100)).length <= 60)

  // Who may use it: a model is set, and a key when the provider needs one.
  const base = { enabled: true, provider: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m", access: "admins" as const, readOnly: false, dailyTokenLimit: null }
  assert.ok(settings.assistantAllowed(base, { isAdmin: true }))
  assert.ok(!settings.assistantAllowed(base, { isAdmin: false }), "admins only by default")
  assert.ok(settings.assistantAllowed({ ...base, access: "everyone" }, { isAdmin: false }))
  assert.ok(!settings.assistantReady({ ...base, apiKey: null }), "OpenRouter needs a key")
  assert.ok(settings.assistantReady({ ...base, provider: "ollama", apiKey: null }), "a local model does not")
  assert.ok(!settings.assistantReady({ ...base, enabled: false }))

  // Turns run apart from the request: whoever follows gets the turn so far, then the rest.
  const runs = await import("../assistant/runs")
  const turn = runs.startRun("conv-1", "u1")!
  assert.ok(turn && runs.startRun("conv-1", "u1") === null, "one turn at a time in a conversation")
  runs.emitRun(turn, { type: "text", delta: "Hel" })
  runs.emitRun(turn, { type: "text", delta: "lo" })
  runs.emitRun(turn, { type: "tool", id: "c1", name: "list_places", arguments: "{}" })
  const late: Array<{ type: string; delta?: string }> = []
  const leave = runs.subscribe(turn, e => { late.push(e) })
  assert.deepEqual(late.map(e => e.type), ["text", "tool"], "a late follower gets what happened, text merged")
  assert.equal(late[0]!.delta, "Hello")
  leave()
  runs.emitRun(turn, { type: "text", delta: " again" })
  assert.equal(late.length, 2, "a follower that left gets nothing more")
  assert.ok(turn.events.length === 3 && !turn.controller.signal.aborted, "and the turn goes on without it")
  assert.ok(runs.runningConversations("u1").has("conv-1") && !runs.runningConversations("u2").has("conv-1"))
  assert.ok(!runs.stopRun("conv-1", "u2"), "only its account stops a turn")
  assert.ok(runs.stopRun("conv-1", "u1") && turn.controller.signal.aborted)
  runs.finishRun(turn)
  assert.equal(runs.getRun("conv-1"), undefined)
  const after: string[] = []
  runs.subscribe(turn, e => { after.push(e.type) })
  assert.equal(after.at(-1), "done", "following a finished turn ends at once")

  // Places closed to AI assistants: refused before the tool runs, cleared from results.
  const ex = await import("../services/ai-exclusions")
  const { runGuarded } = await import("../mcp/context")
  const closed = { ids: new Set(["p-private"]), paths: ["/srv/data/private"] }
  const refused = (args: Record<string, unknown>, o: { changes: boolean; files: boolean }) =>
    assert.throws(() => ex.checkArgs(args, o, closed), (e: any) => e.code === "FORBIDDEN")
  refused({ path: "/srv/data/private/notes.txt" }, { changes: false, files: true })
  refused({ path: "/srv/data/private/../private/x" }, { changes: false, files: true })
  refused({ paths: ["/srv/data/a", "/srv/data/private"] }, { changes: true, files: true })
  refused({ paths: ["/srv/data"] }, { changes: true, files: true })
  refused({ src: "/srv/data/a", dstDir: "/srv/data/private" }, { changes: true, files: true })
  refused({ placeId: "p-private", query: "x" }, { changes: false, files: true })
  ex.checkArgs({ path: "/srv/data" }, { changes: false, files: true }, closed)
  ex.checkArgs({ path: "/srv/data/privateer" }, { changes: true, files: true }, closed)
  ex.checkArgs({ placeId: "p-private" }, { changes: false, files: false }, closed)
  const when = new Date("2026-10-30T00:00:00Z")
  assert.deepEqual(ex.filterResult({ items: [{ path: "/srv/data/private/a", mtime: when }, { path: "/srv/data/b", mtime: when }] }, closed),
    { items: [{ path: "/srv/data/b", mtime: when }] }, "what lies in a closed Place is cleared, dates kept")
  assert.deepEqual(ex.parseIds('["a",3,"b"]'), ["a", "b"])
  let closedRan = false
  const readFile = ALL_TOOLS.find(x => x.name === "read_text_file")!
  await assert.rejects(() => runGuarded({ ...readFile, run: async () => { closedRan = true } }, { path: "/srv/data/private/a.txt" }, {} as any, closed),
    (e: any) => e.code === "FORBIDDEN")
  assert.ok(!closedRan, "a tool never runs on a closed Place")
  const places = ALL_TOOLS.find(x => x.name === "list_places")!
  assert.deepEqual(await runGuarded({ ...places, run: async () => [{ id: "p-private", path: "/srv/data/private" }, { id: "p", path: "/srv/data/pub" }] }, {}, {} as any, closed),
    [{ id: "p", path: "/srv/data/pub" }], "a closed Place is not even listed")

  const Fastify = (await import("fastify")).default
  const rateLimit = (await import("@fastify/rate-limit")).default
  const { assistantRoutes } = await import("../assistant/route")
  const app = Fastify()
  await app.register(rateLimit, { max: 2000, timeWindow: "1 minute" })
  await app.register(assistantRoutes)
  assert.equal((await app.inject({ method: "POST", url: "/assistant/chat", payload: { message: "hi" } })).statusCode, 401, "no session, no chat")
  assert.equal((await app.inject({ method: "GET", url: "/assistant/chat/x/events" })).statusCode, 401, "nor following a turn")
  assert.equal((await app.inject({ method: "POST", url: "/assistant/chat/x/stop" })).statusCode, 401, "nor stopping one")
  assert.equal((await app.inject({ method: "POST", url: "/assistant/chat", payload: { message: "hi" }, headers: { authorization: "Bearer hsi_pat_x" } })).statusCode, 401,
    "an access token cannot chat")
  await app.close()
}
console.log("Backend security tests passed")
