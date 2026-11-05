import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseContainerEnv, serializeContainerEnv } from '../src/lib/container-env.ts'

test('raw environment editing preserves equals signs and empty values', () => {
  assert.deepEqual(parseContainerEnv('TOKEN=a=b\nEMPTY=\n  PORT =8080\n\n# comment\nunfinished'), [
    { key: 'TOKEN', value: 'a=b' }, { key: 'EMPTY', value: '' }, { key: 'PORT', value: '8080' },
  ])
})

test('switching environment modes preserves valid entries', () => {
  const vars = [{ key: 'TOKEN', value: 'a=b' }, { key: 'EMPTY', value: '' }]
  assert.deepEqual(parseContainerEnv(serializeContainerEnv(vars)), vars)
})
