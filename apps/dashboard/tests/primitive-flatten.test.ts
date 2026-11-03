import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTextVNode, createVNode, Fragment, Text } from 'vue'
import { flatten } from '../src/components/ui/flatten.ts'

test('flatten replaces a fragment by its children, recursively', () => {
  const a = createVNode('a')
  const b = createVNode('b')
  const c = createVNode('i')
  const nested = createVNode(Fragment, null, [b, createVNode(Fragment, null, [c])])
  assert.deepEqual(flatten([a, nested]), [a, b, c])
})

test('flatten turns a string child of a fragment into a text vnode', () => {
  const [node] = flatten([createVNode(Fragment, null, ['hello'])])
  assert.equal(node.type, Text)
  assert.equal(node.children, 'hello')
})

test('flatten tolerates a fragment without children and empty values', () => {
  assert.deepEqual(flatten([createVNode(Fragment)]), [])
  assert.deepEqual(flatten([createVNode(Fragment, null, undefined)]), [])
  assert.deepEqual(flatten(undefined), [])
  assert.deepEqual(flatten([null, undefined, false, true]), [])
})

test('flatten keeps text vnodes and flattens nested arrays', () => {
  const text = createTextVNode('x')
  const el = createVNode('p')
  assert.deepEqual(flatten([text, [el, 'y']]).length, 3)
})
