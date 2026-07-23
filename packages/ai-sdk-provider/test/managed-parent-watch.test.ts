import assert from 'node:assert/strict'
import test from 'node:test'

import { parentIsGone } from '../src/managed/index.js'

test('parentIsGone: false while our parent pid is unchanged', () => {
  assert.equal(parentIsGone(4321, 4321), false)
})

test('parentIsGone: true once reparented to init (ppid 1)', () => {
  assert.equal(parentIsGone(4321, 1), true)
})

test('parentIsGone: true on any change of parent pid', () => {
  // A parent dying and us being reparented to a non-init pid (rare, e.g. a
  // subreaper) still counts as "the parent we started under is gone".
  assert.equal(parentIsGone(4321, 9999), true)
})
