import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityPollDelay, formatElapsed, mergeActivity, type ServerTask } from '../src/lib/activity.ts'
import type { Transfer } from '../src/lib/uploads.ts'

function view(p: Partial<ServerTask> & { id: string }): ServerTask {
  return {
    kind: 'copy', status: 'running', meta: { kind: 'copy' }, owner: 'me',
    createdAt: '2026-11-09T12:00:00Z', startedAt: '2026-11-09T12:00:01Z', percent: null, ...p,
  } as ServerTask
}

function upload(p: Partial<Transfer> = {}): Transfer {
  return { id: p.id ?? 'u', kind: 'upload', name: 'a.mkv', destDir: '/srv/Photos', status: 'uploading', ...p }
}

test('mergeActivity hides the finalize job of a local upload', () => {
  const server = [view({ id: 'j1', kind: 'finalize' }), view({ id: 'j2', kind: 'copy' })]
  const uploads = [upload({ id: 'u1', status: 'verifying', finalizeJobIds: ['j1'] })]
  assert.deepEqual(mergeActivity(server, uploads).map(i => i.id), ['u1', 'j2'])
})

test('finished uploads leave the list', () => {
  assert.equal(mergeActivity([], [upload({ id: 'a', status: 'done' }), upload({ id: 'b', status: 'cancelled' })]).length, 0)
})

test('an upload shows its percent and remaining time', () => {
  const [item] = mergeActivity([], [upload({ totalBytes: 1000, sentBytes: 640, bytesPerSec: 120 })])
  assert.equal(item!.percent, 64)
  assert.equal(item!.remainingSec, 3)
  assert.equal(item!.owner, 'browser')
  assert.equal(item!.pausable, true)
})

test('a queued server task stays queued', () => {
  const [item] = mergeActivity([view({ id: 'q', status: 'queued', startedAt: null })], [])
  assert.equal(item!.status, 'queued')
  assert.equal(item!.cancellable, false)
})

test('activityPollDelay', () => {
  assert.equal(activityPollDelay({ running: 0, open: false }), 60000)
  assert.equal(activityPollDelay({ running: 1, open: false }), 3000)
  assert.equal(activityPollDelay({ running: 0, open: true }), 3000)
})

test('formatElapsed', () => {
  assert.equal(formatElapsed(18_000), '18 s')
  assert.equal(formatElapsed(252_000), '4 min 12 s')
  assert.equal(formatElapsed(7_500_000), '2 h 05 min')
})
