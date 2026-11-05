import assert from 'node:assert/strict'
import test from 'node:test'
import { deployApp, isSavedBeforeStartFailure, type DeploymentJob } from '../src/lib/app-deployment.ts'

test('create and start saves once, then reports a worker failure without losing configuration', async () => {
  const configuration = { name: 'media', image: 'example/media:1', ports: [{ hostPort: 8080, containerPort: 80 }] }
  const calls: Array<{ name: string; start: boolean }> = []

  const result = await deployApp(configuration, async (config, start) => {
    calls.push({ name: config.name, start })
    return { jobId: 'job-1' }
  }, async () => ({ status: 'failed', error: 'port is already in use' }))

  assert.deepEqual(calls, [{ name: 'media', start: true }])
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'port is already in use')
  assert.equal(result.configuration, configuration)
})

test('a job that exceeds its observation deadline stays pending', async () => {
  const configuration = { name: 'media', image: 'example/media:1' }
  const result = await deployApp(configuration, async () => ({ jobId: 'job-2' }), async () => ({
    status: 'timeout', error: 'The operation did not finish within 10 minutes. It may still be running; refresh to check.',
  }))

  assert.equal(result.status, 'pending')
  assert.match(result.error ?? '', /may still be running/)
  assert.equal(result.configuration, configuration)
})

test('a task status lookup error remains pending because the worker may still be running', async () => {
  const result = await deployApp({ name: 'media' }, async () => ({ jobId: 'job-lookup-error' }), async () => ({
    status: 'failed', error: 'network unavailable', failureSource: 'observer',
  }))

  assert.equal(result.status, 'pending')
  assert.equal(result.error, 'network unavailable')
})

test('successful job result is returned as completed with its task id', async () => {
  const job: DeploymentJob = { jobId: 'job-3' }
  const result = await deployApp({ name: 'media' }, async () => job, async jobId => {
    assert.equal(jobId, 'job-3')
    return { status: 'completed', error: null }
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.jobId, 'job-3')
})

test('a failed start plan identifies a completed save step for recovery', () => {
  assert.equal(isSavedBeforeStartFailure({ results: [{ status: 'done' }, { status: 'error' }] }), true)
  assert.equal(isSavedBeforeStartFailure({ results: [{ status: 'error' }] }), false)
  assert.equal(isSavedBeforeStartFailure({ results: [] }), false)
})
