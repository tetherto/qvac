/**
 * Behaviour of the `test-e2e-rerun-failed` chain, exercising the real scripts
 * embedded in the workflow / action YAML. `on-pr-test-sdk.yml` is
 * `pull_request_target`, so it and its composite actions always load from the
 * base branch: this suite is the only check that can run before a change to them
 * merges.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  actionScript,
  concurrencyGroup,
  evaluateExpression,
  extractBlockScalar,
  makeContext,
  makeCore,
  makeGithub,
  makeWorkspace,
  planSize,
  readBaseState,
  readPlanComment,
  runBashStep,
  runGithubScript,
  runNodeStep,
  workflowStepRun,
  writeResults,
} from '../lib/sdk-e2e-rerun.mjs'

const BASE_STATE = actionScript('sdk-e2e-base-state', 'Update base state')
const RESOLVE_RERUN = actionScript('sdk-e2e-resolve-rerun', 'Resolve rerun plan')
const VERIFY_RERUN = actionScript('sdk-e2e-verify-rerun', 'Verify planned tests actually ran')
const APPLY_PLAN = workflowStepRun('test-sdk.yml', 'Apply rerun plan')
const LEG_FILTER = workflowStepRun('test-node-sdk.yml', 'Resolve test filter for this platform')
const RESOLVE_CONFIG = workflowStepRun('test-sdk.yml', 'Resolve configuration')

const HEAD_SHA = 'cafe0000000000000000000000000000000000ba'
const OTHER_SHA = 'beef1111111111111111111111111111111111aa'

const DESKTOP_RUNNERS = '["qvac-win25-x64-gpu", "qvac-ubuntu2204-x64-gpu", "qvac-macos26-arm64-gpu"]'
const ELECTRON_RUNNERS = '["qvac-win25-x64-gpu", "qvac-ubuntu2204-x64-gpu", "qvac-macos26-arm64-gpu-gui"]'
const SNAP_RUNNERS = '["qvac-ubuntu2204-x64-gpu"]'

// A base full run: one failure on windows, one on linux, everything else green.
const DESKTOP_BASE = {
  'results-desktop-windows': { total: 120, passed: 119, failed: ['completion-stream-abort'] },
  'results-desktop-linux': { total: 120, passed: 119, failed: ['ocr-pdf-multipage'] },
  'results-desktop-macos': { total: 120, passed: 120, failed: [] },
  'results-android': { total: 90, passed: 90, failed: [] },
  'results-ios': { total: 90, passed: 90, failed: [] },
}

// The extracted scripts read their downloaded artifacts from paths relative to
// the workspace. `node --test` runs each file in its own process, so this cwd is
// not shared with other suites.
const workspace = makeWorkspace()
process.chdir(workspace.dir)
process.on('exit', workspace.cleanup)

async function baseState({
  phase,
  runId,
  comments,
  artifacts = {},
  flatten = false,
  suite = '',
  sha = HEAD_SHA,
  artifactNames,
}) {
  rmSync(join(workspace.dir, '.sdk-e2e-base'), { recursive: true, force: true })
  if (phase === 'finish') {
    writeResults(join(workspace.dir, '.sdk-e2e-base/results'), artifacts, { flatten })
  }
  const core = makeCore()
  await runGithubScript(BASE_STATE, {
    github: makeGithub({
      comments,
      artifacts: artifactNames
        ?? Object.keys(artifacts).map((name, index) => ({ id: index + 1, name })),
    }),
    context: makeContext({ runId, headSha: HEAD_SHA }),
    core,
    env: { PHASE: phase, SUITE: suite, HEAD_SHA: sha },
  })
  return core
}

async function resolveRerun({ comments, runStatuses = {}, runId = 999, headSha = HEAD_SHA }) {
  const core = makeCore()
  await runGithubScript(RESOLVE_RERUN, {
    github: makeGithub({ comments, runStatuses }),
    context: makeContext({ runId, headSha }),
    core,
  })
  return core
}

async function verifyRerun({ plan, artifacts, flatten = false }) {
  rmSync(join(workspace.dir, '.sdk-e2e-verify'), { recursive: true, force: true })
  writeResults(join(workspace.dir, '.sdk-e2e-verify/results'), artifacts, { flatten })
  const core = makeCore()
  await runGithubScript(VERIFY_RERUN, {
    github: makeGithub({}),
    context: makeContext({ runId: 888, headSha: HEAD_SHA }),
    core,
    env: { RERUN_PLAN: plan },
  })
  return core
}

function applyPlan(rerunPlan) {
  return runNodeStep(APPLY_PLAN, {
    cwd: workspace.dir,
    env: {
      RERUN_PLAN: rerunPlan,
      DESKTOP_PLATFORMS: DESKTOP_RUNNERS,
      ELECTRON_PLATFORMS: ELECTRON_RUNNERS,
      SNAP_PLATFORMS: SNAP_RUNNERS,
    },
  }).outputs
}

function legFilter({ plan, consumer, runner, baseFilter = '' }) {
  return runNodeStep(LEG_FILTER, {
    cwd: workspace.dir,
    env: { RERUN_PLAN: plan, BASE_FILTER: baseFilter, CONSUMER: consumer, RUNNER_LABEL: runner },
  }).outputs
}

function resolveConfig(targets) {
  return runBashStep(RESOLVE_CONFIG, {
    cwd: workspace.dir,
    env: {
      EVENT_NAME: 'workflow_call',
      TARGETS: targets,
      SUITE: '',
      SUITE_CUSTOM: '',
      RUN_DESKTOP: '',
      RUN_ELECTRON: '',
      RUN_SNAP: '',
      RUN_ANDROID: '',
      RUN_IOS: '',
      RUN_CALIBRATION: 'off',
    },
  })
}

test('the embedded scripts are extracted, not silently empty', () => {
  assert.match(BASE_STATE, /sdk-e2e-base-state-data:v1:/)
  assert.match(RESOLVE_RERUN, /base run still in progress/)
  assert.match(VERIFY_RERUN, /executed 0 tests/)
  assert.match(APPLY_PLAN, /desktop-platforms/)
  assert.match(LEG_FILTER, /RERUN_PLAN/)
  assert.match(RESOLVE_CONFIG, /run-e2e=/)
})

test('a missing anchor or key throws instead of returning nothing', () => {
  const source = ['      - name: Real step', '        run: |', '          echo hi', ''].join('\n')
  assert.equal(extractBlockScalar(source, { anchor: '- name: Real step', key: 'run' }), 'echo hi')
  assert.throws(
    () => extractBlockScalar(source, { anchor: '- name: Absent step', key: 'run' }),
    /anchor not found/,
  )
  assert.throws(
    () => extractBlockScalar(source, { anchor: '- name: Real step', key: 'script' }),
    /not found under/,
  )
})

test('the extractor stops at the end of its own block', () => {
  // Jobs start at indent 2 with no leading dash, so a search for a key the step
  // does not have must not run on into a later job and match its script.
  const source = [
    '  first-job:',
    '    steps:',
    '      - name: Target',
    '        run: |',
    '          echo mine',
    '',
    '  second-job:',
    '    steps:',
    '      - name: Other',
    '        with:',
    '          script: |',
    '            echo not mine',
    '',
  ].join('\n')
  assert.equal(extractBlockScalar(source, { anchor: '- name: Target', key: 'run' }), 'echo mine')
  assert.throws(
    () => extractBlockScalar(source, { anchor: '- name: Target', key: 'script' }),
    /not found under/,
  )
})

test('a base run records its failures and the rerun narrows to them', async () => {
  const comments = []

  await baseState({ phase: 'start', runId: 100, comments })
  const started = readBaseState(comments)
  assert.equal(started.data.running.runId, 100)
  assert.match(started.body, /base run in progress/)

  // Labelling mid-run must not plan from a half-finished base.
  const midRun = await resolveRerun({ comments, runStatuses: { 100: 'in_progress' } })
  assert.equal(midRun.outputs['should-run'], 'false')
  assert.match(readPlanComment(comments).body, /still in progress/)

  await baseState({ phase: 'finish', runId: 100, comments, artifacts: DESKTOP_BASE })
  const recorded = readBaseState(comments)
  assert.equal(recorded.data.running, null)
  assert.equal(recorded.data.recorded.platforms.length, 5)
  assert.equal(
    comments.filter((comment) => comment.body.includes('<!-- sdk-e2e-base-state -->')).length,
    1,
    'the base state lives in exactly one comment',
  )

  const core = await resolveRerun({ comments, runStatuses: { 100: 'completed' } })
  assert.equal(core.outputs['should-run'], 'true')
  assert.equal(core.outputs.targets, 'desktop')
  assert.equal(planSize(core.outputs['rerun-plan']), 2)

  const narrowed = applyPlan(core.outputs['rerun-plan'])
  assert.deepEqual(
    JSON.parse(narrowed['desktop-platforms']),
    ['qvac-win25-x64-gpu', 'qvac-ubuntu2204-x64-gpu'],
    'the green macOS runner is dropped from the matrix',
  )
  assert.equal(narrowed['electron-platforms'], '[]')
  assert.equal(narrowed['snap-platforms'], '[]')
  assert.equal(narrowed['filter-android'], '')
  assert.equal(narrowed['filter-ios'], '')

  const plan = core.outputs['rerun-plan']
  assert.equal(
    legFilter({ plan, consumer: 'desktop', runner: 'qvac-win25-x64-gpu' }).filter,
    'completion-stream-abort',
  )
  assert.equal(
    legFilter({ plan, consumer: 'desktop', runner: 'qvac-ubuntu2204-x64-gpu' }).filter,
    'ocr-pdf-multipage',
  )

  const verified = await verifyRerun({
    plan,
    artifacts: {
      'results-desktop-windows': {
        total: 1, passed: 1, passedIds: ['completion-stream-abort'], failed: [],
      },
      'results-desktop-linux': {
        total: 1, passed: 1, passedIds: ['ocr-pdf-multipage'], failed: [],
      },
    },
  })
  assert.deepEqual(verified.failures, [])
  assert.deepEqual(verified.warnings, [])
})

test('mobile-only failures skip desktop entirely', async () => {
  const comments = []
  await baseState({
    phase: 'finish',
    runId: 200,
    comments,
    artifacts: {
      'results-desktop-windows': { total: 10, passed: 10, failed: [] },
      'results-android': { total: 10, passed: 8, failed: ['tts-long-text', 'diffusion-sdxl'] },
      'results-ios': { total: 10, passed: 9, failed: ['tts-long-text'] },
    },
  })

  const core = await resolveRerun({ comments, runStatuses: { 200: 'completed' } })
  assert.equal(core.outputs.targets, 'android,ios')
  assert.equal(planSize(core.outputs['rerun-plan']), 3)

  const narrowed = applyPlan(core.outputs['rerun-plan'])
  assert.equal(narrowed['desktop-platforms'], '[]')
  assert.equal(narrowed['filter-android'], 'tts-long-text,diffusion-sdxl')
  assert.equal(narrowed['filter-ios'], 'tts-long-text')
})

test('without a plan the run keeps every runner and the incoming filter', () => {
  const full = applyPlan('')
  assert.equal(JSON.parse(full['desktop-platforms']).length, 3)
  assert.equal(JSON.parse(full['electron-platforms']).length, 3)
  assert.equal(full['filter-android'], '')

  const leg = legFilter({
    plan: '', consumer: 'desktop', runner: 'qvac-macos26-arm64-gpu', baseFilter: 'completion-',
  })
  assert.equal(leg.filter, 'completion-')
})

test('every reusable target still resolves, and keeps run-e2e true', () => {
  const cases = [
    ['desktop + mobile', 'true,false,false,true,true'],
    ['all', 'true,false,false,true,true'],
    ['mobile', 'false,false,false,true,true'],
    ['desktop', 'true,false,false,false,false'],
    ['ios', 'false,false,false,false,true'],
    // Comma-separated family lists come from a rerun plan.
    ['android,ios', 'false,false,false,true,true'],
    ['desktop,android', 'true,false,false,true,false'],
    ['desktop,electron,snap,android,ios', 'true,true,true,true,true'],
  ]
  for (const [targets, expected] of cases) {
    const result = resolveConfig(targets)
    assert.equal(result.status, 0, `"${targets}" should resolve: ${result.stdout}`)
    const flags = [
      result.outputs['run-desktop'], result.outputs['run-electron'], result.outputs['run-snap'],
      result.outputs['run-android'], result.outputs['run-ios'],
    ].join(',')
    assert.equal(flags, expected, `"${targets}"`)
    // prepare-inference / prepare-test-suite are gated on run-e2e.
    assert.equal(result.outputs['run-e2e'], 'true', `"${targets}" run-e2e`)
  }
})

test('a malformed target is rejected', () => {
  for (const targets of ['bogus', 'desktop,bogus', ',']) {
    assert.notEqual(resolveConfig(targets).status, 0, `"${targets}" should fail`)
  }
})

test('with no base recorded the rerun explains itself instead of running', async () => {
  const comments = []
  const core = await resolveRerun({ comments })
  assert.equal(core.outputs['should-run'], 'false')
  assert.match(readPlanComment(comments).body, /no base run/)
  assert.ok(
    core.notices.some((notice) => notice.includes('test-e2e-smoke')),
    'the reason reaches the run log, not just the PR comment',
  )
})

test('a green base has nothing to re-run', async () => {
  const comments = []
  await baseState({
    phase: 'finish',
    runId: 300,
    comments,
    artifacts: { 'results-desktop-linux': { total: 10, passed: 10, failed: [] } },
  })
  const core = await resolveRerun({ comments, runStatuses: { 300: 'completed' } })
  assert.equal(core.outputs['should-run'], 'false')
  assert.match(readPlanComment(comments).body, /base is green/)
})

test('a run with no results keeps the previously recorded base', async () => {
  const comments = []
  await baseState({
    phase: 'finish',
    runId: 400,
    comments,
    artifacts: { 'results-desktop-linux': { total: 10, passed: 9, failed: ['still-relevant'] } },
  })

  await baseState({ phase: 'start', runId: 401, comments })
  const started = readBaseState(comments)
  assert.equal(started.data.recorded.runId, 400, 'start preserves the recorded base')
  assert.equal(started.data.running.runId, 401)

  await baseState({ phase: 'finish', runId: 401, comments, artifacts: {} })
  const after = readBaseState(comments)
  assert.equal(after.data.recorded.runId, 400)
  assert.equal(after.data.running, null, 'the in-flight mark is cleared')

  const core = await resolveRerun({ comments, runStatuses: { 400: 'completed', 401: 'completed' } })
  assert.match(core.outputs['rerun-plan'], /still-relevant/)
})

test('a cancelled base run leaves a stale mark that is ignored, not obeyed', async () => {
  const comments = []
  await baseState({
    phase: 'finish',
    runId: 500,
    comments,
    artifacts: { 'results-desktop-linux': { total: 10, passed: 9, failed: ['old-but-valid'] } },
  })
  // 501 was cancelled, so record-base never ran and `running` was never cleared.
  await baseState({ phase: 'start', runId: 501, comments })

  const core = await resolveRerun({ comments, runStatuses: { 500: 'completed', 501: 'completed' } })
  assert.equal(core.outputs['should-run'], 'true')
  assert.match(core.outputs['rerun-plan'], /old-but-valid/)
  assert.ok(core.warnings.some((warning) => warning.includes('never recorded')))
})

test('a newer base run replaces the older record', async () => {
  const comments = []
  await baseState({
    phase: 'finish',
    runId: 600,
    comments,
    artifacts: { 'results-desktop-linux': { total: 10, passed: 9, failed: ['old-failure'] } },
  })
  await baseState({
    phase: 'finish',
    runId: 601,
    comments,
    artifacts: { 'results-desktop-linux': { total: 10, passed: 9, failed: ['new-failure'] } },
  })

  const core = await resolveRerun({ comments, runStatuses: { 601: 'completed' } })
  assert.match(core.outputs['rerun-plan'], /new-failure/)
  assert.doesNotMatch(core.outputs['rerun-plan'], /old-failure/)
})

test('a lone artifact flattened into path is still read', async () => {
  const comments = []
  await baseState({
    phase: 'finish',
    runId: 700,
    comments,
    flatten: true,
    artifacts: { 'results-ios': { total: 10, passed: 9, failed: ['tts-long-text'] } },
  })
  const core = await resolveRerun({ comments, runStatuses: { 700: 'completed' } })
  assert.equal(core.outputs.targets, 'ios')

  const verified = await verifyRerun({
    plan: core.outputs['rerun-plan'],
    flatten: true,
    artifacts: {
      'results-ios': { total: 1, passed: 1, passedIds: ['tts-long-text'], failed: [] },
    },
  })
  assert.deepEqual(verified.failures, [])
  assert.deepEqual(verified.warnings, [])
})

test('duplicate artifact names from a job re-run are deduped to the newest', async () => {
  const comments = []
  await baseState({
    phase: 'finish',
    runId: 800,
    comments,
    artifacts: {
      'results-desktop-linux': { total: 10, passed: 9, failed: ['second-attempt-failure'] },
    },
    // Attempt 1 has the lower id; the download keeps the newest, so the name must
    // be read once, not twice.
    artifactNames: [
      { id: 1, name: 'results-desktop-linux' },
      { id: 9, name: 'results-desktop-linux' },
    ],
  })
  const state = readBaseState(comments)
  assert.equal(state.data.recorded.platforms.length, 1)
  assert.deepEqual(state.data.recorded.platforms[0].failed, ['second-attempt-failure'])
})

test('a leg that executed nothing fails the rerun', async () => {
  const comments = []
  await baseState({ phase: 'finish', runId: 900, comments, artifacts: DESKTOP_BASE })
  const core = await resolveRerun({ comments, runStatuses: { 900: 'completed' } })

  const verified = await verifyRerun({
    plan: core.outputs['rerun-plan'],
    artifacts: {
      'results-desktop-windows': { total: 0, passed: 0, failed: [] },
      'results-desktop-linux': {
        total: 1, passed: 1, passedIds: ['ocr-pdf-multipage'], failed: [],
      },
    },
  })
  assert.equal(verified.failures.length, 1)
  assert.match(verified.failures[0], /executed 0 tests/)
})

test('a planned id covered only by a prefix sibling does not count as verified', async () => {
  // `--filter=model-load-llm` also selects `model-load-llm-load-mode-none`, so a
  // prefix comparison would call the deleted id covered and stay silent.
  const plan = JSON.stringify({ desktop: { linux: ['model-load-llm'] } })
  const verified = await verifyRerun({
    plan,
    artifacts: {
      'results-desktop-linux': {
        total: 1, passed: 1, passedIds: ['model-load-llm-load-mode-none'], failed: [],
      },
    },
  })
  assert.equal(verified.failures.length, 1, 'nothing planned ran, so the rerun must fail')
  assert.match(verified.failures[0], /none of the 1 planned test id/)
})

test('a partially renamed plan warns but still reports the tests that ran', async () => {
  const plan = JSON.stringify({ desktop: { linux: ['renamed-away', 'ocr-pdf-multipage'] } })
  const verified = await verifyRerun({
    plan,
    artifacts: {
      'results-desktop-linux': {
        total: 1, passed: 1, passedIds: ['ocr-pdf-multipage'], failed: [],
      },
    },
  })
  assert.deepEqual(verified.failures, [])
  assert.equal(verified.warnings.length, 1)
  assert.match(verified.warnings[0], /renamed-away/)
})

test('the plan comment distinguishes a flakiness check from a fix verification', async () => {
  const sameCommit = []
  await baseState({ phase: 'finish', runId: 1000, comments: sameCommit, artifacts: DESKTOP_BASE })
  await resolveRerun({ comments: sameCommit, runStatuses: { 1000: 'completed' } })
  assert.match(readPlanComment(sameCommit).body, /flakiness check/)

  const newCommit = []
  await baseState({
    phase: 'finish', runId: 1001, comments: newCommit, artifacts: DESKTOP_BASE, sha: OTHER_SHA,
  })
  await resolveRerun({ comments: newCommit, runStatuses: { 1001: 'completed' } })
  assert.match(readPlanComment(newCommit).body, /new commit since the base run/)
})

test('each kind of run gets its own concurrency group', () => {
  const template = concurrencyGroup('on-pr-test-sdk.yml')
  assert.doesNotMatch(
    template.replace(/\$\{\{[\s\S]*?\}\}/g, ''),
    /\n/,
    'a literal newline outside an interpolation would land in the group name',
  )

  const base = { workflow: 'w', prNumber: 4200, ref: 'refs/pull/4200/merge', label: null }
  const groupFor = (context) => evaluateExpression(template, { ...base, ...context })

  const baseGroup = groupFor({ action: 'labeled', label: 'test-e2e-smoke' })
  assert.equal(groupFor({ action: 'labeled', label: 'test-e2e-full' }), baseGroup)
  assert.equal(
    groupFor({ action: 'synchronize' }),
    baseGroup,
    'a push still supersedes an in-flight base run',
  )

  // Neither a rerun nor a label this workflow ignores may cancel a base run.
  assert.notEqual(groupFor({ action: 'labeled', label: 'test-e2e-rerun-failed' }), baseGroup)
  assert.notEqual(groupFor({ action: 'labeled', label: 'safe-to-test' }), baseGroup)
  assert.notEqual(
    groupFor({ action: 'labeled', label: 'safe-to-test' }),
    groupFor({ action: 'labeled', label: 'verify' }),
    'two ignored labels must not cancel each other either',
  )
})
