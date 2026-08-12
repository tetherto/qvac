import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PREBUILD_KEYS,
  resolvePublishState,
  expectedPrebuilds,
  flattenPages,
  parseRunId,
  selectNewestBotStatus,
  isRunFresh,
  classifyState,
  evaluatePackage,
  pollPrebuilds,
} from '../prebuild-status/lib.mjs'

const iso = (s) => new Date(s).toISOString()

function status({
  context = 'qvac/prebuild-tts-ggml',
  login = 'github-actions[bot]',
  updated_at,
  target_url,
  state = 'success',
}) {
  return { context, creator: { login }, updated_at, target_url, state }
}

// --- producer side --------------------------------------------------------

test('resolvePublishState: a real success or artifact reuse always passes', () => {
  assert.equal(resolvePublishState('success', 'false', 'success', 'true'), 'success')
  assert.equal(resolvePublishState('failure', 'true', 'success', 'true'), 'success', 'artifact reuse counts as success')
  assert.equal(resolvePublishState('skipped', 'true', 'success', 'true'), 'success', 'reuse-hit skip is a real pass')
})

test('resolvePublishState: a skipped prebuild passes ONLY as a legit no-label skip', () => {
  // ci-router ran and deliberately chose not to build (no prebuild label).
  assert.equal(resolvePublishState('skipped', 'false', 'success', 'false'), 'success')
})

test('resolvePublishState: a failure-induced skip fails closed (Ian: upstream failure must not read as success)', () => {
  // ci-router failed, so run_prebuilds never resolved and prebuild fell through
  // to skipped - this must NOT be published as a green prebuild.
  assert.equal(resolvePublishState('skipped', 'false', 'failure', ''), 'failure')
  // ci-router itself skipped (e.g. PR not authorized) -> not a no-label decision.
  assert.equal(resolvePublishState('skipped', 'false', 'skipped', ''), 'failure')
  assert.equal(resolvePublishState('skipped', 'false', '', ''), 'failure')
  // Skipped while ci-router said run_prebuilds=true is not a no-label skip.
  assert.equal(resolvePublishState('skipped', 'false', 'success', 'true'), 'failure')
  assert.equal(resolvePublishState('skipped', 'false', 'success', ''), 'failure')
})

test('resolvePublishState: a real prebuild failure fails', () => {
  assert.equal(resolvePublishState('failure', 'false', 'success', 'true'), 'failure')
  assert.equal(resolvePublishState('cancelled', '', 'success', 'true'), 'failure')
  assert.equal(resolvePublishState(undefined, undefined, undefined, undefined), 'failure')
})

// --- selection / pagination ----------------------------------------------

test('expectedPrebuilds keeps only allowlisted changed packages', () => {
  assert.deepEqual(expectedPrebuilds(['tts-ggml', 'infer-base', 'vla']), ['tts-ggml', 'vla'])
  assert.deepEqual(expectedPrebuilds([]), [])
  assert.deepEqual(expectedPrebuilds(['decoder-audio']), [])
  assert.deepEqual(expectedPrebuilds(null), [])
})

test('flattenPages merges paginated pages and tolerates a flat array', () => {
  assert.deepEqual(flattenPages([[{ a: 1 }], [{ a: 2 }, { a: 3 }]]), [{ a: 1 }, { a: 2 }, { a: 3 }])
  assert.deepEqual(flattenPages([{ a: 1 }]), [{ a: 1 }])
  assert.deepEqual(flattenPages([]), [])
  assert.deepEqual(flattenPages(null), [])
})

test('selectNewestBotStatus picks the newest bot status across pages (multi-page regression)', () => {
  // Same context split across two pages. A naive per-page ".[0]" would yield two
  // objects; flattened selection must return exactly the newest one.
  const pages = [
    [status({ updated_at: iso('2026-08-10T12:00:00Z'), target_url: 'r/actions/runs/2', state: 'success' })],
    [status({ updated_at: iso('2026-08-10T09:00:00Z'), target_url: 'r/actions/runs/1', state: 'failure' })],
  ]
  const chosen = selectNewestBotStatus(flattenPages(pages), 'qvac/prebuild-tts-ggml')
  assert.equal(chosen.target_url, 'r/actions/runs/2')
  assert.equal(chosen.state, 'success')
})

test('selectNewestBotStatus ignores non-bot creators and non-matching contexts', () => {
  const statuses = [
    status({ login: 'attacker', updated_at: iso('2026-08-10T13:00:00Z'), target_url: 'x/actions/runs/9' }),
    status({ context: 'qvac/prebuild-vla', updated_at: iso('2026-08-10T13:30:00Z'), target_url: 'x/actions/runs/8' }),
    status({ updated_at: iso('2026-08-10T12:00:00Z'), target_url: 'x/actions/runs/2' }),
  ]
  assert.equal(selectNewestBotStatus(statuses, 'qvac/prebuild-tts-ggml').target_url, 'x/actions/runs/2')
  assert.equal(selectNewestBotStatus([], 'qvac/prebuild-tts-ggml'), null)
})

// --- run binding ----------------------------------------------------------

test('parseRunId extracts the numeric run id from a run URL', () => {
  assert.equal(parseRunId('https://github.com/o/r/actions/runs/123456789'), '123456789')
  assert.equal(parseRunId('https://github.com/o/r/actions/runs/123456789/job/42'), '123456789')
  assert.equal(parseRunId('https://github.com/o/r/actions/runs/123?check_suite=1'), '123')
  assert.equal(parseRunId(''), null)
  assert.equal(parseRunId(null), null)
  assert.equal(parseRunId('https://example.com/not-a-run'), null)
})

test('isRunFresh requires the matching workflow and created_at >= threshold', () => {
  const threshold = Math.floor(Date.parse('2026-08-10T12:00:00Z') / 1000)
  const fresh = { path: '.github/workflows/on-pr-tts-ggml.yml', created_at: '2026-08-10T12:00:05Z' }
  const stale = { path: '.github/workflows/on-pr-tts-ggml.yml', created_at: '2026-08-10T11:59:00Z' }
  const wrongWorkflow = { path: '.github/workflows/on-pr-vla.yml', created_at: '2026-08-10T13:00:00Z' }
  assert.equal(isRunFresh(fresh, 'tts-ggml', threshold), true)
  assert.equal(isRunFresh(stale, 'tts-ggml', threshold), false)
  assert.equal(isRunFresh(wrongWorkflow, 'tts-ggml', threshold), false)
  assert.equal(isRunFresh(null, 'tts-ggml', threshold), false)
})

test('classifyState maps commit-status states to gate outcomes', () => {
  assert.equal(classifyState('success'), 'success')
  assert.equal(classifyState('failure'), 'failed')
  assert.equal(classifyState('error'), 'failed')
  assert.equal(classifyState('pending'), 'pending')
  assert.equal(classifyState(''), 'pending')
})

// --- full per-package decision -------------------------------------------

test('evaluatePackage: a superseded pre-label run cannot pass; the fresh labeled run decides', () => {
  const threshold = Math.floor(Date.parse('2026-08-10T12:00:00Z') / 1000) // label event
  const runs = {
    1: { path: '.github/workflows/on-pr-tts-ggml.yml', created_at: '2026-08-10T09:00:00Z' }, // pre-label
    2: { path: '.github/workflows/on-pr-tts-ggml.yml', created_at: '2026-08-10T12:05:00Z' }, // labeled
  }
  const lookup = (id) => runs[id] ?? null

  // Only the pre-label run has posted a skipped success. Its updated_at is after
  // the label event (looks "fresh" by timestamp) but its producing run predates
  // the label, so the gate must stay pending.
  const preLabelOnly = [
    status({ updated_at: iso('2026-08-10T12:00:30Z'), target_url: 'r/actions/runs/1', state: 'success' }),
  ]
  assert.equal(evaluatePackage(preLabelOnly, 'tts-ggml', threshold, lookup), 'pending')

  // The labeled run posts success -> pass.
  const labeledSuccess = [
    ...preLabelOnly,
    status({ updated_at: iso('2026-08-10T13:00:00Z'), target_url: 'r/actions/runs/2', state: 'success' }),
  ]
  assert.equal(evaluatePackage(labeledSuccess, 'tts-ggml', threshold, lookup), 'success')

  // The labeled run posts failure -> fail.
  const labeledFailure = [
    ...preLabelOnly,
    status({ updated_at: iso('2026-08-10T13:00:00Z'), target_url: 'r/actions/runs/2', state: 'failure' }),
  ]
  assert.equal(evaluatePackage(labeledFailure, 'tts-ggml', threshold, lookup), 'failed')
})

test('evaluatePackage: a status whose run resolves to another workflow is rejected', () => {
  const threshold = Math.floor(Date.parse('2026-08-10T12:00:00Z') / 1000)
  const lookup = () => ({ path: '.github/workflows/on-pr-vla.yml', created_at: '2026-08-10T13:00:00Z' })
  const forged = [status({ updated_at: iso('2026-08-10T13:00:00Z'), target_url: 'r/actions/runs/7', state: 'success' })]
  assert.equal(evaluatePackage(forged, 'tts-ggml', threshold, lookup), 'pending')
})

test('evaluatePackage: a status without a parseable producing run stays pending', () => {
  const threshold = Math.floor(Date.parse('2026-08-10T12:00:00Z') / 1000)
  const legacy = [status({ updated_at: iso('2026-08-10T13:00:00Z'), target_url: '', state: 'success' })]
  assert.equal(evaluatePackage(legacy, 'tts-ggml', threshold, () => null), 'pending')
})

test('PREBUILD_KEYS covers the merge-guard allowlist', () => {
  assert.equal(PREBUILD_KEYS.length, 13)
  assert.ok(PREBUILD_KEYS.includes('tts-ggml'))
  assert.ok(PREBUILD_KEYS.includes('vla'))
})

// --- poll loop: retry / deadline / terminal outcomes ---------------------

// A deterministic clock. `sleep` advances virtual time so the loop reaches its
// deadline without any real waiting.
function fakeClock(startMs = 0) {
  let t = startMs
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
  }
}

const THRESHOLD = Math.floor(Date.parse('2026-08-10T12:00:00Z') / 1000)
const FRESH_RUN = { path: '.github/workflows/on-pr-tts-ggml.yml', created_at: '2026-08-10T12:00:00Z' }

test('pollPrebuilds retries a transient statuses fetch error, then passes', async () => {
  const clock = fakeClock()
  const logs = []
  let calls = 0
  const code = await pollPrebuilds({
    expected: ['tts-ggml'],
    prUpdatedEpoch: THRESHOLD,
    fetchStatuses: () => {
      calls += 1
      if (calls === 1) throw new Error('HTTP 503')
      return [status({ updated_at: iso('2026-08-10T12:00:30Z'), target_url: 'r/actions/runs/2', state: 'success' })]
    },
    lookupRun: () => FRESH_RUN,
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 30_000,
    timeoutMs: 180 * 60 * 1000,
    log: (m) => logs.push(m),
  })
  assert.equal(code, 0)
  assert.ok(calls >= 2, 'retried after the transient error')
  assert.ok(logs.some((l) => /statuses fetch failed, retrying/.test(l)), 'warned instead of failing')
})

test('pollPrebuilds fails closed only when statuses fetch keeps failing past the deadline', async () => {
  const clock = fakeClock()
  const logs = []
  const code = await pollPrebuilds({
    expected: ['tts-ggml'],
    prUpdatedEpoch: THRESHOLD,
    fetchStatuses: () => {
      throw new Error('HTTP 502')
    },
    lookupRun: () => null,
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 30_000,
    timeoutMs: 60_000,
    log: (m) => logs.push(m),
  })
  assert.equal(code, 1)
  assert.ok(logs.some((l) => /statuses fetch kept failing/.test(l)))
})

test('pollPrebuilds times out (fail-closed) when a required status never appears', async () => {
  const clock = fakeClock()
  const code = await pollPrebuilds({
    expected: ['tts-ggml'],
    prUpdatedEpoch: THRESHOLD,
    fetchStatuses: () => [],
    lookupRun: () => null,
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 30_000,
    timeoutMs: 60_000,
    log: () => {},
  })
  assert.equal(code, 1)
})

test('pollPrebuilds returns failure immediately when a prebuild status is failed', async () => {
  const clock = fakeClock()
  const code = await pollPrebuilds({
    expected: ['tts-ggml'],
    prUpdatedEpoch: THRESHOLD,
    fetchStatuses: () => [status({ updated_at: iso('2026-08-10T12:01:00Z'), target_url: 'r/actions/runs/2', state: 'failure' })],
    lookupRun: () => FRESH_RUN,
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 30_000,
    timeoutMs: 180 * 60 * 1000,
    log: () => {},
  })
  assert.equal(code, 1)
})
