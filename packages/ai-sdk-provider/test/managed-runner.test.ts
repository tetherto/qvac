import assert from 'node:assert/strict'
import test from 'node:test'

import { decideReap } from '../src/managed/runner.js'

test('decideReap never reaps while a consumer is alive and resets the idle clock', () => {
  const r = decideReap({ liveConsumerCount: 2, emptySince: 1000, now: 5000, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: null, reap: false })
})

test('decideReap starts the idle clock when the consumer set first goes empty', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: null, now: 5000, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: 5000, reap: false })
})

test('decideReap does not reap before the idle timeout elapses', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: 5000, now: 5500, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: 5000, reap: false })
})

test('decideReap reaps once the idle timeout has elapsed with no consumers', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: 5000, now: 6000, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: 5000, reap: true })
})

test('decideReap with a zero timeout (private serve) reaps as soon as the owner is gone', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: null, now: 6000, idleTimeoutMs: 0 })
  assert.deepEqual(r, { emptySince: 6000, reap: true })
})
