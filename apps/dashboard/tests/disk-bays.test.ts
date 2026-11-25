import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bayOwner, bayModel } from '../src/components/storage/disk-bays.ts'
import type { DiskRow } from '../src/components/storage/disk-list.ts'

const row = (name: string, role: DiskRow['role'], extra: Partial<DiskRow> = {}): DiskRow => ({
  disk: { name, size: 4e12, type: 'disk', fstype: '', mountpoint: '', model: 'M', isSystem: role === 'system', isRemovable: false },
  role, raidOwners: [], vgOwners: [], health: 'passed', temperature: 35, kind: 'HDD', label: '', ...extra,
})

test('each disk role maps to the engine that uses it', () => {
  assert.equal(bayOwner('raid'), 'lvm')
  assert.equal(bayOwner('lvm'), 'lvm')
  assert.equal(bayOwner('mounted'), 'lvm')
  assert.equal(bayOwner('free'), 'free')
  assert.equal(bayOwner('system'), 'system')
  assert.equal(bayOwner('unmounted'), 'other')
})

test('a server with only its system disk has one system bay', () => {
  const bays = bayModel([row('nvme0n1', 'system')])
  assert.equal(bays.length, 1)
  assert.equal(bays[0]!.owner, 'system')
})

test('the system disk comes first, then the others by name', () => {
  const bays = bayModel([row('sdf', 'free'), row('sdb', 'raid'), row('nvme0n1', 'system'), row('sda', 'raid')])
  assert.deepEqual(bays.map(b => b.name), ['nvme0n1', 'sda', 'sdb', 'sdf'])
})

test('health, temperature, size and kind come from the row', () => {
  const [b] = bayModel([row('sdc', 'lvm', { health: 'warning', temperature: 41, kind: 'SSD' })])
  assert.deepEqual(b, { name: 'sdc', size: 4e12, owner: 'lvm', health: 'warning', temperature: 41, kind: 'SSD', label: '' })
})

test('a disk without a temperature reading has none', () => {
  const [b] = bayModel([row('sdc', 'lvm', { temperature: 0 })])
  assert.equal(b!.temperature, undefined)
})
