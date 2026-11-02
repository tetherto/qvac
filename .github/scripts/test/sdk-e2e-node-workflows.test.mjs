// Guards the layout of the runner-hosted SDK e2e workflows: test-node-sdk.yml
// (desktop, electron, python), test-snap-sdk.yml (snap), and the sdk-e2e-node-*
// composite actions they share.
//
// Parsed as text on purpose: the job that runs this has no npm install, so no
// YAML library is available. Same approach as ci-trust-policy.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actionStepRun, makeWorkspace, runNodeStep } from '../lib/sdk-e2e-rerun.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path) => readFileSync(join(root, path), 'utf8')

const NODE = '.github/workflows/test-node-sdk.yml'
const SNAP = '.github/workflows/test-snap-sdk.yml'
const CALLER = '.github/workflows/test-sdk.yml'
const RUN_ACTION = '.github/actions/sdk-e2e-node-run/action.yml'

// Comments and descriptions may name a family; only executable lines count.
function codeLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/|description:)/.test(line))
}

// Where the shared actions are checked out, at the commit the workflow was
// loaded from rather than the commit under test.
const WORKFLOW_CHECKOUT = '.sdk-e2e-workflow'

// Each local `uses:`, with whether it resolves in the workflow's own checkout
// or in the checkout of the code under test.
function localActions(source) {
  return [...source.matchAll(/uses:\s*\.\/(\.sdk-e2e-workflow\/)?(\.github\/actions\/[A-Za-z0-9._-]+)/g)]
    .map((m) => ({ dir: m[2], fromWorkflow: Boolean(m[1]) }))
}

// One job's block: from its id line to the next job id (or end of file).
function testJob(source, jobId) {
  const start = source.indexOf(`\n  ${jobId}:\n`)
  assert.notEqual(start, -1, `job ${jobId} not found`)
  const next = source.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next)
}

function sparseList(block) {
  return new Set(block.split('\n').map((line) => line.trim()).filter(Boolean))
}

// The code-under-test checkout is the first sparse list; the workflow's own is
// the one under `path: .sdk-e2e-workflow`.
function checkouts(jobSource) {
  const lists = [...jobSource.matchAll(/(path: (\S+)\n {10})?sparse-checkout: \|\n((?: {12}.*\n)+)/g)]
  const tested = lists.find((m) => !m[2])
  const workflow = lists.find((m) => m[2] === WORKFLOW_CHECKOUT)
  assert.ok(tested, 'test job has no sparse checkout of the code under test')
  assert.ok(workflow, `test job does not check out the shared actions into ${WORKFLOW_CHECKOUT}`)
  return { tested: sparseList(tested[3]), workflow: sparseList(workflow[3]) }
}

// Every local action a job reaches, following composite actions into the
// actions they call: each must be on disk in the checkout it resolves from.
function missingActions(jobSource) {
  const { tested, workflow } = checkouts(jobSource)
  const missing = []
  const seen = new Set()
  const queue = localActions(jobSource)
  while (queue.length > 0) {
    const ref = queue.shift()
    const key = `${ref.fromWorkflow}:${ref.dir}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = ref.fromWorkflow ? workflow : tested
    if (!list.has(ref.dir)) {
      missing.push(`${ref.fromWorkflow ? WORKFLOW_CHECKOUT + '/' : ''}${ref.dir}`)
    }
    const file = `${ref.dir}/action.yml`
    assert.ok(existsSync(join(root, file)), `${ref.dir} has no action.yml`)
    queue.push(...localActions(read(file)))
  }
  return missing
}

for (const [workflow, jobId] of [[NODE, 'test-node'], [SNAP, 'test-snap']]) {
  test(`${workflow}: the test job checks out every local action it reaches`, () => {
    assert.deepEqual(missingActions(testJob(read(workflow), jobId)), [])
  })

  // A PR that predates the shared actions, or a dispatch of an older
  // test-version, has no copy of them in the code under test.
  test(`${workflow}: the shared actions load from the workflow's own commit`, () => {
    const job = testJob(read(workflow), jobId)
    const fromTested = localActions(job).filter(
      (ref) => ref.dir.startsWith('.github/actions/sdk-e2e-node-') && !ref.fromWorkflow,
    )
    assert.deepEqual(fromTested, [])
    const checkout = /ref: \$\{\{ github\.workflow_sha \}\}\n((?: {10}.*\n)*?) {10}path: \.sdk-e2e-workflow\n/.exec(job)
    assert.ok(checkout, 'shared actions are not checked out at github.workflow_sha into .sdk-e2e-workflow')
    // Nothing in that checkout pushes or fetches again.
    assert.match(checkout[1], / {10}persist-credentials: false\n/)
  })
}

test('a missing action is reported against the checkout it resolves from', () => {
  const job = [
    '  test-x:',
    '    steps:',
    '      - uses: actions/checkout@sha',
    '        with:',
    '          sparse-checkout: |',
    '            .github/actions/sdk-e2e-node-prepare',
    '      - uses: actions/checkout@sha',
    '        with:',
    '          ref: ${{ github.workflow_sha }}',
    '          path: .sdk-e2e-workflow',
    '          sparse-checkout: |',
    '            .github/actions/sdk-e2e-node-leg',
    '      - uses: ./.sdk-e2e-workflow/.github/actions/sdk-e2e-node-prepare',
    '',
  ].join('\n')
  assert.deepEqual(missingActions(job).sort(), [
    '.github/actions/sdk-e2e-prepare-inference',
    '.github/actions/sdk-e2e-prepare-test-suite',
    '.sdk-e2e-workflow/.github/actions/sdk-e2e-node-prepare',
  ])
})

test('the shared node workflow carries no Snap step', () => {
  const offending = codeLines(read(NODE)).filter((line) =>
    /\bsnap(craft|d)?\b|\blx[cd]\b|QVAC_TEST_SNAP/i.test(line) && !/test-snap-sdk\.yml/.test(line))
  assert.deepEqual(offending, [])
})

test('the shared actions carry no family-specific branch', () => {
  for (const dir of ['leg', 'prepare', 'run', 'results']) {
    const source = codeLines(read(`.github/actions/sdk-e2e-node-${dir}/action.yml`)).join('\n')
    assert.doesNotMatch(
      source,
      /(['"`])(desktop|electron|python|snap)\1|[=!]=\s*(desktop|electron|python|snap)\b/,
      `sdk-e2e-node-${dir} branches on a family; keep that in the family's workflow`,
    )
  }
})

test('test-sdk.yml routes Snap to its own workflow and the rest to the shared one', () => {
  const caller = read(CALLER)
  for (const [job, workflow] of [
    ['desktop-tests', 'test-node-sdk.yml'],
    ['python-tests', 'test-node-sdk.yml'],
    ['electron-tests', 'test-node-sdk.yml'],
    ['snap-tests', 'test-snap-sdk.yml'],
  ]) {
    const block = testJob(caller, job)
    assert.match(block, new RegExp(`uses: \\./\\.github/workflows/${workflow.replace('.', '\\.')}`), job)
  }
  assert.doesNotMatch(testJob(caller, 'snap-tests'), /consumer:/)
})

// sdk-e2e-node-run finds its own job id by name to build the runId, and the
// report and rerun machinery key on the family in that name.
test('test job names match the name the runId lookup expects', () => {
  assert.match(read(RUN_ACTION), /`\[\$\{process\.env\.CONSUMER\}\] test \(\$\{process\.env\.RUNNER_LABEL\}\)`/)
  assert.match(testJob(read(NODE), 'test-node'), /name: "\[\$\{\{ inputs\.consumer \}\}\] test \(\$\{\{ matrix\.os \}\}\)"/)
  assert.match(testJob(read(SNAP), 'test-snap'), /name: "\[snap\] test \(\$\{\{ matrix\.os \}\}\)"/)
})

test('both workflows accept the inputs test-sdk.yml passes them', () => {
  const caller = read(CALLER)
  for (const [job, workflow] of [
    ['desktop-tests', NODE],
    ['python-tests', NODE],
    ['electron-tests', NODE],
    ['snap-tests', SNAP],
  ]) {
    const passed = [...testJob(caller, job).matchAll(/^ {6}([a-z-]+):/gm)].map((m) => m[1])
    const declared = read(workflow).slice(0, read(workflow).indexOf('    secrets:'))
    for (const input of passed) {
      assert.match(declared, new RegExp(`\\n {6}${input}:\\n`), `${workflow} does not declare ${input}`)
    }
  }
})

// The family and platform guards fail the leg itself, before it installs or
// starts anything; report-start going red alone would not stop the matrix.
test('a leg outside its workflow\'s families or platforms fails before setup', () => {
  const leg = actionStepRun('sdk-e2e-node-leg', 'Resolve test filter for this platform')
  const workspace = makeWorkspace()
  try {
    const run = (env) => runNodeStep(leg, {
      cwd: workspace.dir,
      env: { RERUN_PLAN: '', BASE_FILTER: '', ALLOWED_FAMILIES: '', ALLOWED_PLATFORMS: '', ...env },
    })

    assert.equal(
      run({ CONSUMER: 'electron', RUNNER_LABEL: 'qvac-win25-x64-gpu', ALLOWED_FAMILIES: 'desktop,electron,python' })
        .outputs.platform,
      'windows',
    )
    assert.throws(
      () => run({ CONSUMER: 'snap', RUNNER_LABEL: 'qvac-ubuntu2204-x64-gpu', ALLOWED_FAMILIES: 'desktop,electron,python' }),
      /This workflow runs desktop, electron, python; got family "snap"/,
    )
    assert.equal(
      run({ CONSUMER: 'snap', RUNNER_LABEL: 'qvac-ubuntu2204-x64-gpu', ALLOWED_PLATFORMS: 'linux' }).outputs.platform,
      'linux',
    )
    assert.throws(
      () => run({ CONSUMER: 'snap', RUNNER_LABEL: 'qvac-macos26-arm64-gpu', ALLOWED_PLATFORMS: 'linux' }),
      /runs on linux; runner "qvac-macos26-arm64-gpu" is macos/,
    )
  } finally {
    workspace.cleanup()
  }
})

test('each workflow passes the leg its own guard', () => {
  assert.match(testJob(read(NODE), 'test-node'), /allowed-families: desktop,electron,python\n/)
  assert.match(testJob(read(SNAP), 'test-snap'), /family: snap\n(?: {10}.*\n)*? {10}allowed-platforms: linux\n/)
})

// A called workflow has no runs of its own, so the baseline lookup must name
// the workflow whose runs upload them. Those runs on main rarely end green,
// and a dispatch may not carry every family/platform.
test('the baseline lookup reads the runs that upload baselines', () => {
  const results = read('.github/actions/sdk-e2e-node-results/action.yml')
  const download = /- name: Download baseline[^\n]*\n((?: {6}.*\n)+)/.exec(results)
  assert.ok(download, 'baseline download step not found')
  assert.match(download[1], / {8}workflow: test-sdk\.yml\n/)
  assert.match(download[1], / {8}workflow_conclusion: completed\n/)
  assert.match(download[1], / {8}search_artifacts: true\n/)
  assert.match(read(CALLER), /\n {2}workflow_dispatch:\n/)

  const upload = /- name: Upload baseline[^\n]*\n {6}if: ([^\n]+)\n/.exec(results)
  assert.ok(upload, 'baseline upload step not found')
  assert.match(upload[1], /github\.event_name == 'workflow_dispatch'/)
})
