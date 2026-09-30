import { test } from 'node:test'
import assert from 'node:assert/strict'
import { volumeTargets } from '../src/components/storage/object-targets.ts'

test('an LV volume is found by every name its operations are logged under', () => {
  const t = volumeTargets({ id: 'U-1', device: 'vg0-data', mountPoint: '/srv/data',
    stack: [{ kind: 'filesystem', name: '/srv/data' }, { kind: 'lv', name: 'data' }, { kind: 'vg', name: 'vg0' }] })
  for (const name of ['vg0-data', 'mapper/vg0-data', 'vg0/data', '/srv/data', 'U-1']) assert.ok(t.includes(name), name)
})

test('a missing volume has no UUID target, and a remembered mount point stays', () => {
  const t = volumeTargets({ id: 'missing:/srv/media', mountPoint: undefined, stack: [] }, '/srv/media')
  assert.deepEqual(t, ['/srv/media'])
})
