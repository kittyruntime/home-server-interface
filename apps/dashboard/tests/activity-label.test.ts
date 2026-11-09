import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityLabel } from '../src/lib/activity-label.ts'
import type { ActivityItem } from '../src/lib/activity.ts'

const t = (key: string, p?: Record<string, unknown>) => key + (p ? JSON.stringify(p) : '')

function item(p: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'x', kind: 'copy', status: 'running', meta: { kind: 'copy' }, owner: 'me', startedAt: null,
    percent: null, remainingSec: null, cancellable: false, pausable: false, interrupted: false, ...p,
  } as ActivityItem
}

test('a copy names the last segment of its source and destination', () => {
  const label = activityLabel(item({ meta: { kind: 'copy', src: '/srv/a/Films', dst: '/srv/b/Archives' } }), t)
  assert.ok(label.startsWith('activity.task.copy'))
  assert.ok(label.includes('"src":"Films"') && label.includes('"dst":"Archives"'))
})

test('an unknown kind falls back to a generic label', () => {
  assert.equal(activityLabel(item({ kind: 'other', meta: { kind: 'other' } }), t), 'activity.taskGeneric.other')
})

test('a system task without its details gets the generic label of its kind', () => {
  assert.equal(activityLabel(item({ kind: 'backup', meta: { kind: 'other' } }), t), 'activity.taskGeneric.backup')
})

test('an upload names the file and the folder', () => {
  const label = activityLabel(item({ kind: 'upload', meta: { kind: 'other', name: 'a.mkv', dst: '/srv/Photos/2026' } }), t)
  assert.ok(label.startsWith('activity.task.upload') && label.includes('"dst":"2026"') && label.includes('"name":"a.mkv"'))
})
