import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTRPCClient, httpBatchStreamLink } from '@trpc/client'
import { createSessionAwareFetch, createSessionLink } from '../src/lib/trpc.ts'

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

// The streamed batch answers 200 and carries each call's outcome on its own
// line (the shape the server sends, captured from a real response).
const streamedBatch = (...lines: unknown[]) => async () => new Response(
  [JSON.stringify({ 0: [[0], [null, 0, 0]], 1: [[0], [null, 0, 1]] }), ...lines.map(l => JSON.stringify(l))].join('\n') + '\n',
  { status: 200, headers: { 'content-type': 'application/json' } },
)
const callError = (i: number, code: string, sessionInvalid = false) =>
  [i, 0, [[{ error: { message: code, code: -32001, data: { code, httpStatus: 401, sessionInvalid } } }]]]
const callData = (i: number, data: unknown) => [i, 0, [[{ result: { data } }]]]

function streamClient(fetch: () => Promise<Response>, token: string | null, invalidated: string[], maintenance: string[]) {
  return createTRPCClient<any>({
    links: [
      createSessionLink(() => token, t => invalidated.push(t), () => maintenance.push('503')),
      httpBatchStreamLink({ url: 'http://hsi.test/trpc', fetch }),
    ],
  })
}

test('a streamed batch clears the session rejected on one of its calls and still answers the others', async () => {
  const invalidated: string[] = []
  const client = streamClient(streamedBatch(callError(0, 'UNAUTHORIZED', true), callData(1, { ok: true })), 'stream-session', invalidated, [])

  const [me, other] = await Promise.allSettled([client.user.me.query(), client.system.version.query()])

  assert.equal(me.status, 'rejected')
  assert.deepEqual(other, { status: 'fulfilled', value: { ok: true } })
  assert.deepEqual(invalidated, ['stream-session'])
})

test('a streamed batch keeps the session on an ordinary unauthorized answer', async () => {
  const invalidated: string[] = []
  const client = streamClient(streamedBatch(callError(0, 'UNAUTHORIZED'), callData(1, 1)), 'stream-session', invalidated, [])

  await Promise.allSettled([client.shareLink.unlock.query(), client.system.version.query()])

  assert.deepEqual(invalidated, [])
})

test('a call refused during maintenance in a streamed batch announces the maintenance', async () => {
  const maintenance: string[] = []
  const client = streamClient(streamedBatch(callError(0, 'SERVICE_UNAVAILABLE'), callData(1, 1)), 'stream-session', [], maintenance)

  await Promise.allSettled([client.app.list.query(), client.system.version.query()])

  assert.deepEqual(maintenance, ['503'])
})
