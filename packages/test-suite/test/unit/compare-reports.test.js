import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareReports } from '../../dist/utils/compare-reports.js'

const report = (runId, tests) => ({
  runId,
  summary: { total: tests.length, passed: 0, failed: 0, duration: 0 },
  categories: {},
  tests
})

const result = (testId, outcome, error) => ({ testId, outcome, ...(error ? { error } : {}) })

/** One test, one transition. */
const transition = (from, to) =>
  compareReports(report('base', [result('t', from)]), report('curr', [result('t', to, 'why')]))

test('a pass that turns into a failure is a new failure', () => {
  const changes = transition('success', 'failure')
  assert.deepEqual(changes.newFailures, [{ testId: 't', error: 'why' }])
  assert.equal(changes.coverageRegressions.length, 0)
})

test('a pass that turns incomplete is a coverage regression', () => {
  const changes = transition('success', 'incomplete')
  assert.deepEqual(changes.coverageRegressions, [{ testId: 't', reason: 'why' }])
  assert.equal(changes.newFailures.length, 0)
})

test('a pass that turns skipped is reported apart from the regressions', () => {
  const changes = transition('success', 'skipped')
  assert.deepEqual(changes.newlySkipped, [{ testId: 't', reason: 'why' }])
  assert.equal(changes.coverageRegressions.length, 0)
})

test('the reason comes from incompleteReason when the client set only that', () => {
  const changes = compareReports(
    report('base', [result('t', 'success')]),
    report('curr', [{ testId: 't', outcome: 'incomplete', incompleteReason: 'no binding' }])
  )
  assert.deepEqual(changes.coverageRegressions, [{ testId: 't', reason: 'no binding' }])
})

test('a failure that passes again is fixed', () => {
  const changes = compareReports(
    report('base', [result('t', 'failure')]),
    report('curr', [result('t', 'success')])
  )
  assert.deepEqual(changes.fixedTests, [{ testId: 't' }])
})

test('a state the baseline already had is not a change', () => {
  for (const state of ['incomplete', 'skipped', 'failure', 'success']) {
    const changes = transition(state, state)
    assert.equal(changes.coverageRegressions.length, 0, state)
    assert.equal(changes.newlySkipped.length, 0, state)
    assert.equal(changes.newFailures.length, 0, state)
    assert.equal(changes.fixedTests.length, 0, state)
  }
})

test('a test that stops being reported is removed, not a regression', () => {
  const changes = compareReports(report('base', [result('t', 'success')]), report('curr', []))
  assert.deepEqual(changes.removedTests, ['t'])
  assert.equal(changes.coverageRegressions.length, 0)
})

test('a test the baseline never had is new', () => {
  const changes = compareReports(report('base', []), report('curr', [result('t', 'incomplete')]))
  assert.deepEqual(changes.newTests, ['t'])
  assert.equal(changes.coverageRegressions.length, 0)
})

test('with several runs of one test the worst result decides', () => {
  const changes = compareReports(
    report('base', [result('t', 'success'), result('t', 'success')]),
    report('curr', [result('t', 'success'), result('t', 'incomplete', 'no binding')])
  )
  assert.deepEqual(changes.coverageRegressions, [{ testId: 't', reason: 'no binding' }])

  const withFailure = compareReports(
    report('base', [result('t', 'success')]),
    report('curr', [result('t', 'incomplete'), result('t', 'failure', 'boom')])
  )
  assert.deepEqual(withFailure.newFailures, [{ testId: 't', error: 'boom' }])
  assert.equal(withFailure.coverageRegressions.length, 0)
})

test('a baseline that was not green is never a coverage regression', () => {
  const changes = compareReports(
    report('base', [result('t', 'success'), result('t', 'failure')]),
    report('curr', [result('t', 'incomplete')])
  )
  assert.equal(changes.coverageRegressions.length, 0)
})

test('the command exits non-zero only on a coverage regression', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-compare-'))
  const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))
  const write = (name, tests) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(report(name, tests)))

  write('baseline.json', [result('t', 'success')])
  write('regressed.json', [result('t', 'incomplete', 'no binding')])
  write('skipped.json', [result('t', 'skipped', 'needs two GPUs')])

  const run = (current) =>
    spawnSync(process.execPath, [
      cli,
      'report:compare',
      `--baseline=${path.join(dir, 'baseline.json')}`,
      `--current=${path.join(dir, current)}`,
      `--output=${path.join(dir, 'out.json')}`
    ])

  assert.equal(run('regressed.json').status, 1)
  assert.equal(run('skipped.json').status, 0)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).changes.newlySkipped.length,
    1,
    'the comparison is written before the exit code is set'
  )
})
