import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safePinnedUrl } from '../src/lib/pinned-url.ts'

test('safePinnedUrl preserves absolute HTTP and HTTPS URLs', () => {
  assert.equal(safePinnedUrl('https://media.example.com/library'), 'https://media.example.com/library')
  assert.equal(safePinnedUrl('http://192.168.1.20:8080/app'), 'http://192.168.1.20:8080/app')
})

test('safePinnedUrl rejects absent, malformed, and active-content URLs', () => {
  assert.equal(safePinnedUrl(null), null)
  assert.equal(safePinnedUrl(undefined), null)
  assert.equal(safePinnedUrl('not a URL'), null)
  assert.equal(safePinnedUrl('javascript:alert(1)'), null)
  assert.equal(safePinnedUrl('data:text/html,<script>alert(1)</script>'), null)
})
