import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearAppJob, knownAppJobs, registerAppJob } from '../src/lib/app-jobs.ts'

test('registerAppJob reserves a name until the matching job is confirmed terminal', () => {
  registerAppJob({ name: 'media', jobId: 'job-1', action: 'start' })
  assert.deepEqual(knownAppJobs.get('media'), { name: 'media', jobId: 'job-1', action: 'start' })

  clearAppJob('media', 'older-job')
  assert.equal(knownAppJobs.get('media')?.jobId, 'job-1')

  clearAppJob('media', 'job-1')
  assert.equal(knownAppJobs.has('media'), false)
})

test('a newer job replaces an old job for the same app', () => {
  registerAppJob({ name: 'media', jobId: 'job-1', action: 'start' })
  registerAppJob({ name: 'media', jobId: 'job-2', action: 'apply' })

  clearAppJob('media', 'job-1')
  assert.equal(knownAppJobs.get('media')?.jobId, 'job-2')
  clearAppJob('media', 'job-2')
})
