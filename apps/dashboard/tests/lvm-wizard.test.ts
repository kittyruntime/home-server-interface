import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orphanPvNames, pvCreateNeeded, withOrphanPvs } from '../src/components/storage/lvm-wizard.ts'

const pvs = [
  { name: '/dev/sdb', vgName: '' },      // left over by a cancelled wizard
  { name: '/dev/sdc', vgName: 'data' },  // in use
]

test('orphan PVs are the ones without a volume group', () => {
  assert.deepEqual([...orphanPvNames(pvs)], ['sdb'])
})

test('pvcreate is skipped for disks that are already orphan PVs', () => {
  assert.deepEqual(pvCreateNeeded(['sdb', 'sdd'], pvs), ['sdd'])
  assert.deepEqual(pvCreateNeeded(['sdb'], pvs), [])
})

test('orphan PVs are offered again by the wizard', () => {
  const devices = [
    { name: 'sdb', children: [] },
    { name: 'sdc', children: [] },
    { name: 'sdd', children: [{ name: 'sdd1', children: [] }] },
  ]
  const eligible = [devices[2]!.children[0]!]
  assert.deepEqual(withOrphanPvs(eligible, devices, pvs).map(d => d.name), ['sdd1', 'sdb'])
})
