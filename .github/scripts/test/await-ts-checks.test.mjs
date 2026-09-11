import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyConclusion, pollForCheck } from '../await-ts-checks/lib.mjs'

const NAME = 'llm-pr-head-ts-checks / ts-checks'

const done = (conclusion) => [{ name: NAME, status: 'completed', conclusion }]
const running = () => [{ name: NAME, status: 'in_progress', conclusion: null }]

// Drives pollForCheck with a scripted sequence of fetchChecks results. Each
// element is either an array of check runs to return, or an Error to throw; the
// last element repeats. A virtual clock advances one tick per sleep, so the
// timeout is deterministic without real time.
function run(sequence, { timeoutTicks = 1000 } = {}) {
  let calls = 0
  let clock = 0
  const logs = []
  return pollForCheck({
    checkName: NAME,
    fetchChecks: () => {
      const step = sequence[Math.min(calls, sequence.length - 1)]
      calls++
      if (step instanceof Error) throw step
      return step
    },
    now: () => clock,
    sleep: async () => {
      clock += 1
    },
    pollIntervalMs: 1,
    timeoutMs: timeoutTicks,
    log: (m) => logs.push(m),
  })
}

test('classifyConclusion: success passes, real failures fail, the rest wait', () => {
  assert.equal(classifyConclusion('success'), 'pass')
  assert.equal(classifyConclusion('failure'), 'fail')
  assert.equal(classifyConclusion('timed_out'), 'fail')
  assert.equal(classifyConclusion('action_required'), 'fail')
  assert.equal(classifyConclusion('cancelled'), 'wait')
  assert.equal(classifyConclusion('skipped'), 'wait')
  assert.equal(classifyConclusion('neutral'), 'wait')
  assert.equal(classifyConclusion('stale'), 'wait')
})

test('success on first poll -> 0', async () => {
  assert.equal(await run([done('success')]), 0)
})

test('failure -> 1', async () => {
  assert.equal(await run([done('failure')]), 1)
})

test('timed_out -> 1', async () => {
  assert.equal(await run([done('timed_out')]), 1)
})

test('action_required -> 1', async () => {
  assert.equal(await run([done('action_required')]), 1)
})

test('cancelled then success (superseding run) -> 0', async () => {
  assert.equal(await run([done('cancelled'), done('success')]), 0)
})

test('stale cancelled then a real failure -> 1 (no swallowed failure)', async () => {
  assert.equal(await run([done('cancelled'), done('failure')]), 1)
})

test('in_progress then success -> 0', async () => {
  assert.equal(await run([running(), done('success')]), 0)
})

test('transient API error then success -> 0', async () => {
  assert.equal(await run([new Error('502 Bad Gateway'), done('success')]), 0)
})

test('check never appears -> timeout 1', async () => {
  assert.equal(await run([[]], { timeoutTicks: 3 }), 1)
})

test('cancelled forever -> timeout 1 (fails closed)', async () => {
  assert.equal(await run([done('cancelled')], { timeoutTicks: 3 }), 1)
})

test('wrong-name check present -> timeout 1 (never false-passes)', async () => {
  const other = [{ name: 'something-else', status: 'completed', conclusion: 'success' }]
  assert.equal(await run([other], { timeoutTicks: 3 }), 1)
})

test('persistent API error to deadline -> 1', async () => {
  assert.equal(await run([new Error('secondary rate limit')], { timeoutTicks: 3 }), 1)
})
