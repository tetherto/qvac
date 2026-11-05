import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyWorkerMetadata } from './verify-published-worker.mjs'

test('tokenless published workers cannot pass the release gate', () => {
  assert.throws(() => verifyWorkerMetadata({ version: '0.18.2' }, '0.18.2'), /token-v1/)
})
test('authenticated but mismatched versions cannot pass', () => {
  assert.throws(() => verifyWorkerMetadata({ version: '0.18.3', qvacIpcAuthentication: 'token-v1' }, '0.18.2'))
})
test('lockstep authenticated metadata passes', () => {
  verifyWorkerMetadata({ version: '0.18.3', qvacIpcAuthentication: 'token-v1' }, '0.18.3')
})
