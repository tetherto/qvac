/**
 * Covers the impact-based smoke expansion: `test-e2e-smoke` also running the
 * tests a PR touched.
 *
 * Same reason as sdk-e2e-rerun.test.mjs — `on-pr-test-sdk.yml` is
 * `pull_request_target`, so it and its composite actions always load from the
 * base branch and no run on a PR can exercise an edit to them.
 *
 * `analyze` is imported from the shipped mapper and fed a catalog directly:
 * loading the real test definitions needs esbuild, which `policy-tests` does not
 * install, but the executor patterns and the import graph are read from the real
 * repository so a rename there fails these tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  actionScript,
  makeCore,
  makeGithub,
  makeWorkspace,
  repoRoot,
  runGithubScript,
} from '../lib/sdk-e2e-rerun.mjs'
import { analyze, parseHunkRanges } from '../../../packages/sdk/e2e/scripts/impacted-tests.mjs'

const REPORT_IMPACTED = actionScript('sdk-e2e-report-impacted', 'Post impact summary')

const E2E = 'packages/sdk/e2e'
const abs = (relative) => join(repoRoot, relative)

// Ids chosen to match executor patterns that exist in the repository, so
// relations 2 and 3 resolve against the real files rather than a fake graph.
const CATALOG = [
  { testId: 'ocr-basic', suites: ['smoke'], metadata: { estimatedDurationMs: 60_000 } },
  { testId: 'ocr-rotated', metadata: { estimatedDurationMs: 30_000 } },
  { testId: 'rag-ingest', metadata: { estimatedDurationMs: 120_000 } },
  { testId: 'system-resources-capabilities', metadata: { estimatedDurationMs: 5_000 } },
  { testId: 'system-resources-sample', metadata: { estimatedDurationMs: 5_000 } },
]

const DEFINITIONS = new Map([
  [
    abs(`${E2E}/tests/system-resources-tests.ts`),
    ['system-resources-capabilities', 'system-resources-sample'],
  ],
])

function run({ changed, hunksByFile }) {
  return analyze({ repoRoot, catalog: CATALOG, idsByDefinitionFile: DEFINITIONS, changed, hunksByFile })
}

async function renderSummary(report) {
  const workspace = makeWorkspace()
  try {
    const reportPath = join(workspace.dir, 'impacted.json')
    if (report !== null) writeFileSync(reportPath, JSON.stringify(report))
    const comments = []
    const core = makeCore()
    await runGithubScript(REPORT_IMPACTED, {
      github: makeGithub({ comments }),
      context: {
        repo: { owner: 'tetherto', repo: 'qvac' },
        payload: { pull_request: { number: 7 } },
      },
      core,
      env: { IMPACTED_JSON: reportPath },
    })
    return { body: comments[0]?.body, core }
  } finally {
    workspace.cleanup()
  }
}

test('the report action script is extracted, not silently empty', () => {
  assert.match(REPORT_IMPACTED, /sdk-e2e-impacted/)
  assert.match(REPORT_IMPACTED, /changedFilesInScope/)
})

test('a changed definitions file adds the tests smoke would have skipped', () => {
  const report = run({ changed: [`${E2E}/tests/system-resources-tests.ts`] })

  assert.deepEqual(report.affected, ['system-resources-capabilities', 'system-resources-sample'])
  assert.deepEqual(report.coveredBySmoke, [])
  assert.deepEqual(report.alsoTests, [
    'system-resources-capabilities',
    'system-resources-sample',
  ])
  assert.equal(report.attribution[0].via, 'definitions (whole file)')
})

test('a hunk that names one test narrows to it instead of the whole file', () => {
  const source = `${E2E}/tests/system-resources-tests.ts`
  const lines = readFileSync(abs(source), 'utf8').split('\n')
  const lineNo = lines.findIndex((line) => line.includes("'system-resources-sample'")) + 1
  assert.ok(lineNo > 0, 'fixture assumption: the id appears as a literal')

  const report = run({
    changed: [source],
    hunksByFile: new Map([[source, [[lineNo, lineNo]]]]),
  })

  assert.equal(report.attribution[0].via, 'definitions (changed lines)')
  assert.deepEqual(report.affected, ['system-resources-sample'])
})

test('a hunk that names no test widens to every test in the file', () => {
  const source = `${E2E}/tests/system-resources-tests.ts`
  const report = run({
    changed: [source],
    // Line 1 is the type-only import: a real change, but not one naming a test.
    hunksByFile: new Map([[source, [[1, 1]]]]),
  })

  assert.equal(report.attribution[0].via, 'definitions (whole file)')
  assert.equal(report.affected.length, 2)
})

test('a changed executor maps through its own pattern', () => {
  const report = run({ changed: [`${E2E}/tests/shared/executors/node/ocr-executor.ts`] })

  assert.equal(report.attribution[0].via, 'executor pattern')
  assert.deepEqual(report.affected, ['ocr-basic', 'ocr-rotated'])
  // ocr-basic is tagged smoke, so only the other one is added.
  assert.deepEqual(report.alsoTests, ['ocr-rotated'])
  assert.deepEqual(report.coveredBySmoke, ['ocr-basic'])
})

test('a shared helper maps through the import graph', () => {
  // The turbovec case from the SDK e2e thread: neither a definitions file nor an
  // executor, reachable only because RagExecutor imports it.
  const report = run({ changed: [`${E2E}/tests/shared/rag-turbovec-runner.ts`] })

  assert.equal(report.attribution[0].via, 'import graph')
  assert.deepEqual(report.affected, ['rag-ingest'])
})

test('consumer.ts, fixtures and assets are reported as unmapped, not dropped', () => {
  const report = run({
    changed: [
      `${E2E}/tests/desktop/consumer.ts`,
      `${E2E}/fixtures/qvac.config.e2e.json`,
      `${E2E}/assets/audio/sample.wav`,
    ],
  })

  assert.equal(report.changedFilesInScope, 3)
  assert.equal(report.unmapped.length, 3)
  assert.deepEqual(report.alsoTests, [])
})

test('files outside the e2e trees are ignored entirely', () => {
  const report = run({ changed: ['packages/sdk/src/index.ts', 'README.md'] })

  assert.equal(report.changedFilesInScope, 0)
  assert.deepEqual(report.unmapped, [])
  assert.deepEqual(report.affected, [])
})

test('an impact set is never truncated, and its runtime is reported', () => {
  const report = run({
    changed: [
      `${E2E}/tests/shared/executors/node/ocr-executor.ts`,
      `${E2E}/tests/system-resources-tests.ts`,
    ],
  })

  // Bounded by the catalog, so extending a smoke run can never cost more than a
  // full run; the runtime is surfaced instead of capped.
  assert.equal(report.alsoTests.length, 3)
  assert.ok(report.addedMinutes > 0)
  assert.equal(report.alsoTests.length + report.coveredBySmoke.length, report.affected.length)
})

test('an id that could not survive a shell is rejected, not passed on', () => {
  const report = analyze({
    repoRoot,
    catalog: [{ testId: 'ocr-basic; rm -rf /', metadata: {} }],
    idsByDefinitionFile: DEFINITIONS,
    changed: [`${E2E}/tests/shared/executors/node/ocr-executor.ts`],
  })

  assert.deepEqual(report.rejectedIds, ['ocr-basic; rm -rf /'])
  assert.deepEqual(report.alsoTests, [])
})

test('a repo root that does not contain the mapper fails loudly', () => {
  assert.throws(
    () => analyze({ repoRoot: '/tmp', catalog: CATALOG, idsByDefinitionFile: DEFINITIONS, changed: [] }),
    /does not contain/
  )
})

test('hunk headers are parsed from unified diff, single-line form included', () => {
  assert.deepEqual(parseHunkRanges('@@ -1 +4 @@\n@@ -9,2 +12,3 @@'), [
    [4, 4],
    [12, 14],
  ])
  // A pure deletion carries no added lines and must not produce a range.
  assert.deepEqual(parseHunkRanges('@@ -3,2 +2,0 @@'), [])
  assert.deepEqual(parseHunkRanges(''), [])
})

test('the summary reports what was added and lists what it could not attribute', async () => {
  const report = run({
    changed: [`${E2E}/tests/system-resources-tests.ts`, `${E2E}/tests/desktop/consumer.ts`],
  })
  const { body } = await renderSummary(report)

  assert.match(body, /additionally covers \*\*2\*\*/)
  assert.match(body, /tests\/desktop\/consumer\.ts/)
  // Paths are shortened for readability, so the package prefix must be gone.
  assert.doesNotMatch(body, /packages\/sdk\/e2e\/tests/)
})

test('a PR touching no e2e file posts nothing', async () => {
  const report = run({ changed: ['README.md'] })
  const { body } = await renderSummary(report)

  assert.equal(body, undefined)
})

test('a missing report says the analysis was unavailable instead of staying quiet', async () => {
  // The mapper is fail-open so it can never block e2e, which is exactly why a
  // failure has to be visible: a plain smoke run must not look like coverage.
  const { body } = await renderSummary(null)

  assert.match(body, /impact analysis unavailable/)
  assert.match(body, /may not have run/)
})

test('the workflow passes the mapper output through to every family', () => {
  const testSdk = readFileSync(join(repoRoot, '.github/workflows/test-sdk.yml'), 'utf8')
  const families = testSdk.match(/^ {6}also-tests: \$\{\{ inputs\.also-tests \}\}$/gm) ?? []
  assert.equal(families.length, 5, 'desktop, electron, snap, android and ios each forward it')

  const onPr = readFileSync(join(repoRoot, '.github/workflows/on-pr-test-sdk.yml'), 'utf8')
  assert.match(onPr, /also-tests: \$\{\{ needs\.resolve-impacted\.outputs\.also-tests \}\}/)
})
