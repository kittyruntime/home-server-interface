import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesLabel, locationLabel, parentPath, retentionLabel, runLabel, scheduleLabel } from '../src/lib/backup.ts'

test('scheduleLabel names each schedule', () => {
  assert.equal(scheduleLabel({ every: 'manual', minute: 0, hour: 0, weekday: 0 }), 'Manual')
  assert.equal(scheduleLabel({ every: 'hourly', minute: 5, hour: 0, weekday: 0 }), 'Every hour at :05')
  assert.equal(scheduleLabel({ every: 'daily', minute: 30, hour: 2, weekday: 0 }), 'Every day at 02:30')
  assert.equal(scheduleLabel({ every: 'weekly', minute: 0, hour: 3, weekday: 1 }), 'Every Monday at 03:00')
})

test('retentionLabel lists only the kept periods', () => {
  assert.equal(retentionLabel({ keepLast: 0, keepDaily: 7, keepWeekly: 4, keepMonthly: 0 }), 'Keeps 7 daily, 4 weekly')
  assert.equal(retentionLabel({ keepLast: 10, keepDaily: 0, keepWeekly: 0, keepMonthly: 1 }), 'Keeps the last 10, 1 monthly')
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
