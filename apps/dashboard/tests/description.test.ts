import { test } from 'node:test'
import assert from 'node:assert/strict'
import { driftTitle, reapplyRequest } from '../src/components/storage/description.ts'

const item = (kind: string, text: string) => ({ kind, text })

test('driftTitle sums up the differences', () => {
  assert.equal(driftTitle([]), '')
  assert.equal(driftTitle([item('fstab-missing', 'The fstab entry for /srv/data is missing')]), 'The fstab entry for /srv/data is missing')
  assert.equal(driftTitle([item('a', 'x'), item('b', 'y'), item('c', 'z')]), '3 differences from its description')
})

test('reapplyRequest asks to start a stopped array without its missing disks', () => {
  assert.deepEqual(reapplyRequest('/srv/data', [item('fstab-missing', 'x')]), { input: { mountPoint: '/srv/data' } })
  assert.deepEqual(
    reapplyRequest('/srv/data', [item('array-stopped', 'Array U (md0) is not running'), item('disk-missing', 'Disk WD-1 is not connected')]),
    { input: { mountPoint: '/srv/data', degraded: true }, acknowledge: 'Start the array without WD-1: it has no redundancy until a disk is added' },
  )
  // A missing disk of a running array is not something Reapply starts without.
  assert.deepEqual(reapplyRequest('/srv/data', [item('disk-missing', 'Disk WD-1 is not connected')]), { input: { mountPoint: '/srv/data' } })
})
