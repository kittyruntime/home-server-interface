import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrayTargets, vgTargets, volumeTargets } from '../src/components/storage/object-targets.ts'

test('an LV volume is found by every name its operations are logged under', () => {
  const t = volumeTargets({ id: 'U-1', device: 'vg0-data', mountPoint: '/srv/data',
    stack: [{ kind: 'filesystem', name: '/srv/data' }, { kind: 'lv', name: 'data' }, { kind: 'vg', name: 'vg0' }] })
  for (const name of ['vg0-data', 'mapper/vg0-data', 'vg0/data', '/srv/data', 'U-1']) assert.ok(t.includes(name), name)
})

test('a missing volume has no UUID target, and a remembered mount point stays', () => {
  const t = volumeTargets({ id: 'missing:/srv/media', mountPoint: undefined, stack: [] }, '/srv/media')
  assert.deepEqual(t, ['/srv/media'])
})

test('array and volume group targets match what the audit writes', () => {
  assert.deepEqual(arrayTargets({ name: 'md0', members: ['sdb1', 'sdc1'] }), ['md0', '/dev/md0', 'sdb1', 'sdc1'])
  const t = vgTargets({ name: 'vg-0', lvs: ['my-data'] })
  for (const n of ['vg-0', 'vg-0/my-data', 'mapper/vg--0-my--data']) assert.ok(t.includes(n), n)
})
