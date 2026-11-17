import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bySize } from '../npm-publish-platform-packages.mjs'

const slices = (...names) => names.map((name) => ({ name, version: '1.0.0' }))
const names = (list) => list.map((s) => s.name)

test('slices under the budget keep their order', () => {
  const sizes = { a: 30, b: 10, c: 20 }
  const { order, sized } = bySize(slices('a', 'b', 'c'), (s) => sizes[s.name], 100)
  assert.deepEqual(names(order), ['a', 'b', 'c'])
  assert.ok(sized.every((x) => !x.over))
})

test('over-budget slices publish first, largest first', () => {
  const sizes = { a: 50, b: 150, c: 20, d: 300 }
  const { order } = bySize(slices('a', 'b', 'c', 'd'), (s) => sizes[s.name], 100)
  assert.deepEqual(names(order), ['d', 'b', 'a', 'c'])
})

test('a size equal to the budget is within it', () => {
  const { sized } = bySize(slices('a'), () => 100, 100)
  assert.equal(sized[0].over, false)
})

test('an unreadable size counts as over budget and largest', () => {
  const sizes = { a: 150, b: undefined, c: 20, d: 'big' }
  const sizeOf = (s) => {
    if (s.name === 'e') throw new Error('npm pack failed')
    return sizes[s.name]
  }
  const { order, sized } = bySize(slices('a', 'b', 'c', 'd', 'e'), sizeOf, 100)
  assert.deepEqual(names(order), ['b', 'd', 'e', 'a', 'c'])
  assert.deepEqual(
    sized.filter((x) => x.size === null).map((x) => x.slice.name),
    ['b', 'd', 'e']
  )
})
