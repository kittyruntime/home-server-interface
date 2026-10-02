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

async function testReviewFixes() {
  const key = Buffer.alloc(32, 5)

  // Live preview must not put form secrets in a GET query string (request logs).
  const { notificationsRouter } = await import("../trpc/routers/notifications")
  assert.equal((notificationsRouter as any)._def.procedures.renderPreview._def.mutation, true)

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

  assert.deepEqual(vg.backupLocalPaths({ direction: "push", source: "/mnt/data", destination: "/remote", remoteHost: "nas2" }), ["/mnt/data"])
  assert.deepEqual(vg.backupLocalPaths({ direction: "pull", source: "/remote", destination: "/mnt/b", remoteHost: "nas2" }), ["/mnt/b"])
  assert.deepEqual(vg.backupLocalPaths({ direction: "push", source: "/mnt/a", destination: "/mnt/b", remoteHost: null }), ["/mnt/a", "/mnt/b"])

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
  assert.ok(sp.PLAN_OPS.includes("format") && sp.PLAN_OPS.includes("raid.stop") && sp.PLAN_OPS.length === 18)
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
  const stacks: Record<string, string> = { web: "services:\n  web:\n    image: nginx:1.27\n" }
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
    findPlace: async (id) => id === "p1" ? { id: "p1", name: "Media", path: "/mnt/media" } : null,
    placeAtPath: async (path) => path === "/mnt/taken",
    catalog: (id) => (id === "demo" ? manifest as any : undefined),
    secret: () => `generated-${secretN++}`,
    effects: {
      writeStack: effect("writeStack") as any, removeStackDir: effect("removeStackDir") as any, mkdirp: effect("mkdirp") as any,
      createPlace: effect("createPlace") as any, validate: effect("validate") as any, publishJob: effect("publishJob") as any,
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

  // install: new Place, compose file with a generated secret (masked), up.
  const inst = { id: "demo", name: "demo1", ports: [], env: [], volumes: [{ target: "/data", source: { kind: "newPlace", name: "Demo data", path: "/srv/demo" } }] }
  const p1 = await ap.buildAppPlan("app.install", inst, deps)
  const p2 = await ap.buildAppPlan("app.install", inst, deps)
  assert.deepEqual(p1.steps.map(s => s.kind), ["create", "create", "create", "run"])
  assert.ok(!JSON.stringify(ap.publicSteps(p1)).includes("generated-"))
  assert.equal(ap.appFingerprint(p1, inst), ap.appFingerprint(p2, inst), "a random secret must not make the plan stale")
  await assert.rejects(ap.buildAppPlan("app.install", { ...inst, volumes: [{ target: "/data", source: { kind: "newPlace", name: "x", path: "/mnt/taken" } }] }, deps), /Place already exists/)

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
    { id: "a1", action: "storage.apply", target: "sdb1", success: true, createdAt: at, user: { username: "admin" },
      meta: JSON.stringify({ input: {}, plan: { op: "format", steps: [{ kind: "run", target: "/dev/sdb1", summary: "Format", status: "done" }] } }) },
    { id: "a2", action: "storage.mount", target: "sdb1", success: false, createdAt: at, user: null, meta: "{not json" },
  ]
  const out = activityEntries(rows as any)
  assert.deepEqual(out[0], { id: "a1", action: "storage.apply", target: "sdb1", success: true, at: at.toISOString(), user: "admin", op: "format", steps: [{ summary: "Format", status: "done" }] })
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
      throw Object.assign(new Error("request timed out"), { code: "TIMEOUT" })
    },
  })), (e: any) => /may still be running/.test(e.message))

  // Stale: CONFLICT.
  await assert.rejects(vp.applyVolume(input as any, "other", deps()), (e: any) => e.code === "CONFLICT")
  // Places and shares are for admins.
  await assert.rejects(vp.previewVolume(input as any, deps({ isAdmin: false })), (e: any) => e.code === "FORBIDDEN")
  // Without a Place there is no share.
  await assert.rejects(vp.previewVolume({ volume: input.volume, share: { smbName: "x" } } as any, deps()), (e: any) => e.code === "BAD_REQUEST")
}

console.log("Backend security tests passed")
