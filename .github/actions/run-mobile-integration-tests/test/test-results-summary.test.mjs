import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { COLLECT_ACTION, makeWorkspace, runStep, writeFixture } from './composite-step.mjs'

const SUMMARY_STEP = 'Build test-case results summary'
const PLATFORM = 'Android'
const ADDON_NAME = '@qvac/audiogen-ggml'
const CONSOLE_DIR = join('console-logs', PLATFORM)
const JOB = 'Manual-28-Android-385814644341-manual-Samsung_Galaxy_S25_Ultra_Samsung_Galaxy_S25_Ultra'
const RESULTS_FILE = join(CONSOLE_DIR, `${JOB}_test-results.json`)
const DETAILS_FILE = join(CONSOLE_DIR, 'test-case-details.json')

const PASSED = 'passed'
const SKIPPED = 'skipped'
const FAST_PASS_MS = 129
const FAST_RUNNER = 'testLoadModels'
const INTERRUPTED_RUNNER = 'testGenerateMusicOnGpu'

function summarize(t, tests) {
  const context = makeWorkspace(t)
  writeFixture(context.workspace, RESULTS_FILE, JSON.stringify({ tests }))
  runStep(COLLECT_ACTION, SUMMARY_STEP, { ...context, env: { PLATFORM, ADDON_NAME } })
  return JSON.parse(readFileSync(join(context.workspace, DETAILS_FILE), 'utf8'))
}

function runnerStatuses(details, runner) {
  const row = details.runners.find((candidate) => candidate.runner === runner)
  assert.ok(row, `runner "${runner}" missing from the summary`)
  return Object.values(row.results).map((result) => result.status)
}

test('a runner that passed quickly is reported as passed', (t) => {
  const details = summarize(t, [{ title: FAST_RUNNER, status: PASSED, duration: FAST_PASS_MS }])
  assert.deepEqual(runnerStatuses(details, FAST_RUNNER), [PASSED])
})

test('a runner the session ended before finishing is reported as skipped', (t) => {
  const details = summarize(t, [{ title: INTERRUPTED_RUNNER, status: SKIPPED, duration: 0 }])
  assert.deepEqual(runnerStatuses(details, INTERRUPTED_RUNNER), [SKIPPED])
})
