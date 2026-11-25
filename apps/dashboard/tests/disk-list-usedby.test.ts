import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usedBy, toolable, type DiskRow } from '../src/components/storage/disk-list.ts'

const row = (role: DiskRow['role'], extra: Partial<DiskRow> = {}): DiskRow => ({
  disk: { name: 'sdb', size: 4e12, type: 'disk', fstype: '', mountpoint: '', model: 'M', isSystem: role === 'system', isRemovable: false },
  role, raidOwners: [], vgOwners: [], poolOwners: [], health: 'passed', temperature: 35, kind: 'HDD', label: '', ...extra,
})

test('who uses a disk, and where it leads', () => {
  assert.deepEqual(usedBy(row('raid', { raidOwners: ['md0'] })), { owner: 'lvm', text: 'RAID md0', target: { kind: 'array', name: 'md0' } })
  assert.deepEqual(usedBy(row('lvm', { vgOwners: ['data'] })), { owner: 'lvm', text: 'VG data', target: { kind: 'vg', name: 'data' } })
  assert.deepEqual(usedBy(row('zfs', { poolOwners: ['tank'] })), { owner: 'zfs', text: 'ZFS tank', target: { kind: 'pool', name: 'tank' } })
  assert.equal(usedBy(row('mounted')).owner, 'lvm')
  assert.equal(usedBy(row('mounted')).target, null)
  assert.equal(usedBy(row('free')).owner, 'free')
  assert.equal(usedBy(row('system')).owner, 'system')
  assert.equal(usedBy(row('unmounted')).owner, 'other')
  assert.equal(usedBy(row('raid')).target, null, 'an inactive array has nowhere to lead')
})

test('the partition tools touch only disks no engine uses', () => {
  for (const r of ['free', 'unmounted', 'mounted'] as const) assert.equal(toolable(row(r)), true, r)
  for (const r of ['system', 'raid', 'lvm', 'zfs'] as const) assert.equal(toolable(row(r)), false, r)
})
