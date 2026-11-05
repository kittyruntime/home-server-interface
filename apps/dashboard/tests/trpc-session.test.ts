import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionAwareFetch } from '../src/lib/trpc.ts'

const errorResult = (message: string, sessionInvalid = false) => ({
  error: { message, code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401, sessionInvalid } },
})
const errorResponse = (message: string, sessionInvalid = false) => new Response(JSON.stringify(errorResult(message, sessionInvalid)), {
  status: 401, headers: { 'content-type': 'application/json' },
})

test('tRPC keeps the signed-in session after a public share password rejection', async () => {
  const invalidated: string[] = []
  const fetchWithSession = createSessionAwareFetch(async () => errorResponse('Wrong password'), token => invalidated.push(token))

  await fetchWithSession('/trpc/shareLink.unlock', { headers: { Authorization: 'Bearer current-session' } })

  assert.deepEqual(invalidated, [])
})

test('tRPC clears the exact stored token rejected by protected session middleware', async () => {
  let storedToken = 'expired-session'
  const fetchWithSession = createSessionAwareFetch(async () => errorResponse('UNAUTHORIZED', true), token => {
    if (storedToken === token) storedToken = ''
  })

  await fetchWithSession('/trpc/user.me', { headers: { Authorization: 'Bearer expired-session' } })

  assert.equal(storedToken, '')
})

test('tRPC does not clear a newer session after an older request is rejected', async () => {
  let storedToken = 'new-session'
  const fetchWithSession = createSessionAwareFetch(async () => errorResponse('UNAUTHORIZED', true), token => {
    if (storedToken === token) storedToken = ''
  })

  await fetchWithSession('/trpc/user.me', { headers: { Authorization: 'Bearer old-session' } })

  assert.equal(storedToken, 'new-session')
})

test('tRPC recognizes a session rejection inside a mixed 207 batch', async () => {
  const invalidated: string[] = []
  const fetchWithSession = createSessionAwareFetch(async () => new Response(JSON.stringify([
    { result: { data: { ok: true } } }, errorResult('UNAUTHORIZED', true),
  ]), { status: 207, headers: { 'content-type': 'application/json' } }), token => invalidated.push(token))

  await fetchWithSession('/trpc/user.me,shareLink.unlock', { headers: { Authorization: 'Bearer batch-session' } })

  assert.deepEqual(invalidated, ['batch-session'])
})

test('tRPC ignores malformed 401 bodies and returns the response body untouched', async () => {
  const invalidated: string[] = []
  const fetchWithSession = createSessionAwareFetch(async () => new Response('gateway error', { status: 401 }), token => invalidated.push(token))

  const response = await fetchWithSession('/trpc/user.me', { headers: { Authorization: 'Bearer current-session' } })

  assert.deepEqual(invalidated, [])
  assert.equal(await response.text(), 'gateway error')
})
