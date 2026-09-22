import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyConclusion, findCheck, pollForCheck } from '../await-ts-checks/lib.mjs'

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

test('classifyConclusion: success and an intentional skip pass, real failures fail, the rest wait', () => {
  assert.equal(classifyConclusion('success'), 'pass')
  // The producer skips a package's ts-checks when nx finds its TypeScript is not
  // affected, so there is nothing to gate on. Treating that as a failure made any
  // PR touching a package's workflow but not its code unmergeable.
  assert.equal(classifyConclusion('skipped'), 'pass')
  assert.equal(classifyConclusion('failure'), 'fail')
  assert.equal(classifyConclusion('timed_out'), 'fail')
  assert.equal(classifyConclusion('action_required'), 'fail')
  assert.equal(classifyConclusion('cancelled'), 'wait')
  assert.equal(classifyConclusion('neutral'), 'wait')
  assert.equal(classifyConclusion('stale'), 'wait')
})

test('a skipped check returns success and says why', async () => {
  const logs = []
  const code = await pollForCheck({
    checkName: 'ocr-ggml-pr-head-ts-checks',
    fetchChecks: async () => [
      { name: 'ocr-ggml-pr-head-ts-checks', status: 'completed', conclusion: 'skipped' },
    ],
    now: () => 0,
    sleep: async () => {},
    pollIntervalMs: 1,
    timeoutMs: 1000,
    log: (m) => logs.push(m),
  })
  assert.equal(code, 0)
  assert.match(logs.join('\n'), /was skipped — nx found no affected TypeScript/)
  // It must not be reported as a success it never had.
  assert.doesNotMatch(logs.join('\n'), /succeeded\./)
})

test('a real failure is still a failure', async () => {
  const logs = []
  const code = await pollForCheck({
    checkName: 'ocr-ggml-pr-head-ts-checks',
    fetchChecks: async () => [
      { name: 'ocr-ggml-pr-head-ts-checks', status: 'completed', conclusion: 'failure' },
    ],
    now: () => 0,
    sleep: async () => {},
    pollIntervalMs: 1,
    timeoutMs: 1000,
    log: (m) => logs.push(m),
  })
  assert.equal(code, 1)
  assert.match(logs.join('\n'), /completed with conclusion: failure/)
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

// A skipped CALLER job produces one check run under the bare caller-job name;
// the nested "<caller> / <job>" run the callers poll for never exists.
const CALLER = 'llm-pr-head-ts-checks'
const bare = (status, conclusion) => [{ name: CALLER, status, conclusion }]

test('findCheck: the exact job-level name wins whenever it is present', () => {
  const rows = [
    { name: CALLER, status: 'completed', conclusion: 'skipped' },
    { name: NAME, status: 'completed', conclusion: 'failure' },
  ]
  assert.equal(findCheck(rows, NAME).conclusion, 'failure')
})

test('findCheck: falls back to the bare caller-job name only when it is a completed skip', () => {
  assert.equal(findCheck(bare('completed', 'skipped'), NAME).name, CALLER)
  assert.equal(findCheck(bare('completed', 'success'), NAME), undefined)
  assert.equal(findCheck(bare('completed', 'failure'), NAME), undefined)
  assert.equal(findCheck(bare('in_progress', null), NAME), undefined)
})

test('findCheck: a name with no " / " separator has no fallback', () => {
  const rows = [{ name: 'diffusion', status: 'completed', conclusion: 'skipped' }]
  assert.equal(findCheck(rows, 'diffusion-pr-head-ts-checks'), undefined)
})

test('findCheck: tolerates a missing or empty check-run list', () => {
  assert.equal(findCheck(undefined, NAME), undefined)
  assert.equal(findCheck([], NAME), undefined)
})

test('a skipped caller job (bare name only) passes instead of timing out', async () => {
  const logs = []
  const code = await pollForCheck({
    checkName: NAME,
    fetchChecks: async () => bare('completed', 'skipped'),
    now: () => 0,
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1,
    log: (msg) => logs.push(msg),
  })
  assert.equal(code, 0)
  assert.match(logs.join('\n'), /llm-pr-head-ts-checks was skipped/)
})

test('a bare caller-job success alone does not pass; the nested run is required', async () => {
  assert.equal(await run([bare('completed', 'success')], { timeoutTicks: 3 }), 1)
})
