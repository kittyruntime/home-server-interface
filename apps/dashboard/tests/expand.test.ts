import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optionLabel, expansionLine } from '../src/components/storage/expand.ts'

test('optionLabel names the way and the gain', () => {
  assert.equal(optionLabel('raidAddDisk', 4 * 1024 ** 4), 'Add a disk to the RAID array (+4.00 TB)')
  assert.equal(optionLabel('vgFree', 1024 ** 4), 'Use the free space of the volume group (+1.00 TB)')
  assert.equal(optionLabel('addDisk', 2 * 1024 ** 4), 'Add a disk to the volume (+2.00 TB)')
  assert.equal(optionLabel('mirrorGrow', 500 * 1024 ** 3), 'Use the larger disks of the mirror (+500.00 GB)')
})

test('expansionLine says where an expansion stands', () => {
  assert.equal(expansionLine({ phase: 'reshape' }, 34), 'Expanding: reshape 34%, then the filesystem')
  assert.equal(expansionLine({ phase: 'reshape' }, null), 'Expanding: the filesystem grows once the array is ready')
  assert.equal(expansionLine({ phase: 'failed', error: 'x' }, null), 'Expansion failed: x')
  assert.equal(expansionLine({ phase: 'done' }, null), '')
})
