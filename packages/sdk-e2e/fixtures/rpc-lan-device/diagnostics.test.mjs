import test from 'node:test'
import assert from 'node:assert/strict'
import { describeError } from './diagnostics.mjs'

test('health and teardown records retain native codes, nested causes and cleanup failures', () => {
  const native = Object.assign(new Error('link down'), { code: 'ENETDOWN' })
  const close = Object.assign(new Error('close failed'), { code: 17 })
  const failure = new AggregateError([native, close], 'teardown failed', { cause: native })
  const recorded = describeError(failure)
  assert.equal(recorded.cause.code, 'ENETDOWN')
  assert.deepEqual(
    recorded.errors.map(({ code }) => code),
    ['ENETDOWN', 17]
  )
  assert.deepEqual(
    recorded.errors.map(({ message }) => message),
    ['link down', 'close failed']
  )
})

test('cyclic and wide error trees cannot produce unbounded diagnostic records', () => {
  const failure = new AggregateError([], 'x'.repeat(10000))
  failure.cause = failure
  failure.errors = Array.from({ length: 1000 }, () => failure)
  const recorded = describeError(failure)
  assert.equal(recorded.message.length, 512)
  assert.equal(recorded.errors.length, 3)
  assert.ok(JSON.stringify(recorded).length < 10000)
})
