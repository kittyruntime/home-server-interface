import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asksOverwriteConfirm, canCloseReveal, clip, defaultRepository, latestOnly, locationSecretsRequired, poller, RESTORE_GRACE_MS, restorePollStep,
  asksRepositoryPassword, breadcrumbs, bytesLabel, commonPrefix, restorePayload, durationLabel, emptyPlanForm, emptyRepositoryForm, locationLabel, parentPath, planFormOf, planPayload,
  pollDelay, repositoryFormOf, repositoryPayload, runLabel, scheduleLabel, untilLabel,
} from '../src/lib/backup.ts'

test('scheduleLabel names each schedule', () => {
  assert.equal(scheduleLabel({ every: 'manual', minute: 0, hour: 0, weekday: 0 }), 'Manual')
  assert.equal(scheduleLabel({ every: 'hourly', minute: 5, hour: 0, weekday: 0 }), 'Every hour at :05')
  assert.equal(scheduleLabel({ every: 'daily', minute: 30, hour: 2, weekday: 0 }), 'Every day at 02:30')
  assert.equal(scheduleLabel({ every: 'weekly', minute: 0, hour: 3, weekday: 1 }), 'Every Monday at 03:00')
})

test('locationLabel shows where a repository lives', () => {
  assert.equal(locationLabel({ type: 'local', path: '/srv/usb/restic' }), '/srv/usb/restic')
  assert.equal(locationLabel({ type: 'sftp', user: 'nas', host: 'backup.lan', port: 22, path: '/data' }), 'nas@backup.lan:/data')
  assert.equal(locationLabel({ type: 'sftp', user: 'nas', host: 'backup.lan', port: 2222, path: '/data' }), 'nas@backup.lan:2222:/data')
  assert.equal(locationLabel({ type: 's3', endpoint: 's3.example.com', bucket: 'hsi', path: 'home' }), 's3.example.com/hsi/home')
  assert.equal(locationLabel({ type: 'rest', url: 'https://nas2.lan:8000/hsi/' }), 'https://nas2.lan:8000/hsi/')
})

test('runLabel reads a run result', () => {
  assert.deepEqual(runLabel(null), { text: 'Never run', tone: 'muted' })
  assert.equal(runLabel({ status: 'failed', error: 'disk full' }).tone, 'err')
  assert.equal(runLabel({ status: 'success', end: '2026-10-20T02:00:00Z' }, new Date('2026-10-20T03:00:00Z')).text, 'Succeeded 1 h ago')
})

test('bytesLabel and parentPath', () => {
  assert.equal(bytesLabel(0), '0 B')
  assert.equal(bytesLabel(1536), '1.5 KB')
  assert.equal(bytesLabel(5 * 1024 ** 3), '5.0 GB')
  assert.equal(parentPath('/srv/a/b'), '/srv/a')
  assert.equal(parentPath('/srv'), '/')
})

const ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
const REPO = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'

test('untilLabel and durationLabel read times', () => {
  const now = new Date('2026-10-20T02:00:00Z')
  assert.equal(untilLabel(null, now), 'Not scheduled')
  assert.equal(untilLabel('2026-10-20T01:00:00Z', now), 'due now')
  assert.equal(untilLabel('2026-10-20T02:30:00Z', now), 'in 30 min')
  assert.equal(untilLabel('2026-10-21T03:00:00Z', now), 'in 1 d')
  assert.equal(durationLabel('2026-10-20T02:00:00Z'), '')
  assert.equal(durationLabel('2026-10-20T02:00:00Z', '2026-10-20T02:03:05Z'), '3 min 5 s')
  assert.equal(durationLabel('2026-10-20T02:00:00Z', '2026-10-20T03:12:00Z'), '1 h 12 min')
})

test('pollDelay polls fast only while a plan runs', () => {
  assert.equal(pollDelay([{ progress: null }]), 60_000)
  assert.equal(pollDelay([{ progress: null }, { progress: { percentDone: 0.4 } }]), 5_000)
})

test('planPayload sends the versions options only, one source per line', () => {
  const f = emptyPlanForm(ID, REPO)
  f.name = ' Photos '
  f.versions.sources = '/srv/photos\n\n /srv/docs \n'
  f.versions.excludes = '*.tmp'
  f.versions.stopApps = ['immich']
  const p = planPayload(f)
  assert.equal(p.name, 'Photos')
  assert.equal('sync' in p, false)
  assert.deepEqual(p.versions, {
    sources: ['/srv/photos', '/srv/docs'], repository: REPO, excludes: ['*.tmp'], stopApps: ['immich'],
    retention: { keepLast: 0, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
  })
})

test('planPayload clears the remote fields of a local sync', () => {
  const f = emptyPlanForm(ID)
  f.type = 'sync'
  Object.assign(f.sync, { source: '/srv/a', destination: '/srv/b', remoteHost: 'old.lan', remoteUser: 'bk', sshKeyPath: '/root/.ssh/k', remotePort: 2222 })
  const p = planPayload(f)
  assert.equal('versions' in p, false)
  assert.equal(p.sync?.remoteHost, '')
  assert.equal(p.sync?.remoteUser, '')
  assert.equal(p.sync?.sshKeyPath, '')
  assert.equal(p.sync?.remotePort, 22)
  f.sync.remote = true
  assert.equal(planPayload(f).sync?.remotePort, 2222)
})

test('planFormOf round-trips a saved plan', () => {
  const plan = {
    id: ID, name: 'Nightly', type: 'sync' as const, enabled: false, schedule: { every: 'weekly', minute: 5, hour: 3, weekday: 2 },
    sync: { direction: 'push', source: '/srv/a', destination: '/backup', remoteHost: 'nas2', remoteUser: 'bk', remotePort: 22,
      sshKeyPath: '/root/.ssh/k', deleteExtra: true, compress: false, bandwidthLimit: 500, excludes: ['.cache/', '*.tmp'] },
  }
  const f = planFormOf(plan)
  assert.equal(f.sync.remote, true)
  assert.equal(f.sync.excludes, '.cache/\n*.tmp')
  const { id, name, type, enabled, schedule, sync } = planPayload(f)
  assert.deepEqual({ id, name, type, enabled, schedule, sync }, plan)
})

test('repositoryPayload sends the fields and secrets of the type only', () => {
  const f = emptyRepositoryForm(REPO)
  f.name = 'Offsite'
  f.type = 's3'
  Object.assign(f, { endpoint: 's3.example.com', bucket: 'hsi', path: 'home', host: 'stale', url: 'stale' })
  Object.assign(f.secrets, { accessKeyId: 'AK', secretAccessKey: 'SK', restPassword: 'stale' })
  assert.deepEqual(repositoryPayload(f), {
    repository: { id: REPO, name: 'Offsite', type: 's3', endpoint: 's3.example.com', bucket: 'hsi', path: 'home',
      check: { every: 'weekly', hour: 4, weekday: 0, day: 1, subset: '5%' } },
    secrets: { password: '', accessKeyId: 'AK', secretAccessKey: 'SK' },
  })
  f.type = 'sftp'
  Object.assign(f, { user: 'nas', host: 'backup.lan', port: 2222, path: '/data' })
  f.secrets.sshKeyPath = '/root/.ssh/hsi'
  const p = repositoryPayload(f)
  assert.deepEqual(p.repository, { id: REPO, name: 'Offsite', type: 'sftp', user: 'nas', host: 'backup.lan', port: 2222, path: '/data', check: p.repository.check })
  assert.deepEqual(p.secrets, { password: '', sshKeyPath: '/root/.ssh/hsi' })
})

test('repositoryFormOf leaves the secrets empty', () => {
  const f = repositoryFormOf({ id: REPO, name: 'USB', type: 'local', path: '/mnt/usb/restic', port: 0, check: { every: 'monthly', hour: 5, weekday: 0, day: 15, subset: '10%' } })
  assert.equal(f.path, '/mnt/usb/restic')
  assert.equal(f.port, 22)
  assert.deepEqual(f.check, { every: 'monthly', hour: 5, weekday: 0, day: 15, subsetPercent: 10 })
  assert.equal(Object.values(f.secrets).every(v => v === ''), true)
})

test('refusals are told apart by the worker code, not the message', () => {
  assert.equal(asksRepositoryPassword('EPASSWORD'), true)
  assert.equal(asksRepositoryPassword('EUNREACHABLE'), false)
  assert.equal(asksOverwriteConfirm('ECONFIRM'), true)
  assert.equal(asksOverwriteConfirm(''), false)
})

test('commonPrefix is the deepest directory shared by the snapshot paths', () => {
  assert.equal(commonPrefix([]), '/')
  assert.equal(commonPrefix(['/mnt/data/docs']), '/mnt/data/docs')
  assert.equal(commonPrefix(['/mnt/data/docs', '/mnt/data/photos']), '/mnt/data')
  assert.equal(commonPrefix(['/mnt/data/docs', '/mnt/data/docs2']), '/mnt/data')
  assert.equal(commonPrefix(['/mnt/a', '/srv/b']), '/')
})

test('breadcrumbs lead from the browsing root to the current folder', () => {
  assert.deepEqual(breadcrumbs('/mnt/data', '/mnt/data'), [{ name: '/mnt/data', path: '/mnt/data' }])
  assert.deepEqual(breadcrumbs('/mnt/data/a/b', '/mnt/data'), [
    { name: '/mnt/data', path: '/mnt/data' }, { name: 'a', path: '/mnt/data/a' }, { name: 'b', path: '/mnt/data/a/b' },
  ])
  assert.deepEqual(breadcrumbs('/a', '/'), [{ name: '/', path: '/' }, { name: 'a', path: '/a' }])
  assert.deepEqual(breadcrumbs('/mnt/datax', '/mnt/data'), [{ name: '/mnt/data', path: '/mnt/data' }])
})

test('restorePayload only confirms an overwrite of the original location', () => {
  assert.deepEqual(restorePayload('r', 's', '/p', 'new', true), { repository: 'r', snapshot: 's', path: '/p', target: 'new', confirmOverwrite: false })
  assert.equal(restorePayload('r', 's', '/p', 'original', true).confirmOverwrite, true)
  assert.equal(restorePayload('r', 's', '/p', 'original', false).confirmOverwrite, false)
})

test('labels survive odd values', () => {
  assert.equal(scheduleLabel({ every: 'weekly', minute: 0, hour: 3, weekday: 9 }), 'Every week at 03:00')
  assert.equal(runLabel({ status: 'success', end: 'not a date' }).text, 'Succeeded')
  assert.deepEqual(runLabel({ status: 'queued' }), { text: 'Unknown state', tone: 'muted' })
  assert.equal(locationLabel({ type: 'sftp', user: 'nas', host: 'backup.lan' }), 'nas@backup.lan:')
  assert.equal(bytesLabel(1024 * 1024 - 1), '1.0 MB')
  assert.equal(bytesLabel(1023 * 1024), '1023.0 KB')
  // An emoji is two UTF-16 units: a cut never leaves half of one.
  assert.equal(clip('ab😀c', 3), 'ab😀')
  assert.equal(runLabel({ status: 'failed', error: 'x'.repeat(119) + '😀😀' }).text, 'Failed: ' + 'x'.repeat(119) + '😀')
})

test('defaultRepository picks a repository added while the form is open', () => {
  assert.equal(defaultRepository('', [{ id: 'r1' }]), 'r1')
  assert.equal(defaultRepository('r2', [{ id: 'r1' }, { id: 'r2' }]), 'r2')
  assert.equal(defaultRepository('gone', [{ id: 'r1' }]), 'r1')
  assert.equal(defaultRepository('', []), '')
})

test('the keys of a new repository type are required on an edit', () => {
  assert.equal(locationSecretsRequired(null, 's3'), true)
  assert.equal(locationSecretsRequired('s3', 's3'), false)
  assert.equal(locationSecretsRequired('local', 'sftp'), true)
})

test('a generated password closes only once stored', () => {
  assert.equal(canCloseReveal('new', false), false)
  assert.equal(canCloseReveal('new', true), true)
  assert.equal(canCloseReveal('ask', false), true)
})

test('restorePollStep gives up after the grace period only', () => {
  const t0 = 1_000_000
  assert.deepEqual(restorePollStep(null, t0, t0 + 1000), { state: 'wait', since: t0 })
  assert.deepEqual(restorePollStep({ progress: { percentDone: 0 }, result: null }, t0, t0 + RESTORE_GRACE_MS + 5), { state: 'wait', since: t0 + RESTORE_GRACE_MS + 5 })
  assert.deepEqual(restorePollStep({ progress: null, result: null }, t0, t0 + RESTORE_GRACE_MS), { state: 'wait', since: t0 })
  assert.deepEqual(restorePollStep({ progress: null, result: null }, t0, t0 + RESTORE_GRACE_MS + 1), { state: 'gone' })
  const done = { status: 'success' }
  assert.deepEqual(restorePollStep({ progress: null, result: done }, t0, t0 + 10 * RESTORE_GRACE_MS), { state: 'done', result: done })
})

test('latestOnly lets the latest load land', () => {
  const loads = latestOnly()
  const first = loads.next()
  const second = loads.next()
  assert.equal(first(), false)
  assert.equal(second(), true)
  loads.next()
  assert.equal(second(), false)
})

test('poller stops for good, even when a run ends after stop', async () => {
  const scheduled: Array<() => void> = []
  let runs = 0
  let release: () => void = () => {}
  const p = poller(() => new Promise<void>(r => { runs++; release = r }), () => 5, { set: fn => { scheduled.push(fn); return scheduled.length }, clear: () => {} })
  const first = p.now()
  release()
  await first
  assert.equal(scheduled.length, 1)
  scheduled[0]!()
  p.stop()
  release()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(runs, 2)
  assert.equal(scheduled.length, 1, 'nothing scheduled after stop')
})
