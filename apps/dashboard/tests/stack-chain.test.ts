import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainOf } from '../src/components/storage/stack-chain.ts'

test('a RAID1 volume reads from its disks up to its folder', () => {
  const chain = chainOf({
    stack: [
      { kind: 'filesystem', name: '/srv/data' }, { kind: 'lv', name: 'data' }, { kind: 'vg', name: 'data' },
      { kind: 'array', name: 'md0' }, { kind: 'disk', name: 'sdb' }, { kind: 'disk', name: 'sda' },
    ],
    fstype: 'ext4', mountPoint: '/srv/data',
  })
  assert.deepEqual(chain, [
    { kind: 'disks', names: ['sda', 'sdb'] },
    { kind: 'array', names: ['md0'] },
    { kind: 'vg', names: ['data'] },
    { kind: 'filesystem', names: ['ext4'] },
    { kind: 'mount', names: ['/srv/data'] },
  ])
})

test('a single-disk volume has no array and no volume group', () => {
  const chain = chainOf({
    stack: [{ kind: 'filesystem', name: '/mnt/usb' }, { kind: 'partition', name: 'sdg1' }, { kind: 'disk', name: 'sdg' }],
    fstype: 'exfat', mountPoint: '/mnt/usb',
  })
  assert.deepEqual(chain.map(s => s.kind), ['disks', 'filesystem', 'mount'])
})

test('a missing volume has no chain', () => {
  assert.deepEqual(chainOf({ stack: [] }), [])
})

test('an unmounted volume stops at its filesystem', () => {
  const chain = chainOf({ stack: [{ kind: 'filesystem', name: 'sdh1' }, { kind: 'disk', name: 'sdh' }], fstype: 'ext4' })
  assert.deepEqual(chain.map(s => s.kind), ['disks', 'filesystem'])
})
