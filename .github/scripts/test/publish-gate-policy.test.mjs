// Locks the wrapper-drift gate on the publish pipelines. Nothing else can:
// on-merge-* never runs on a pull request, and actionlint checks structure,
// not semantics.
// Requires jq on PATH to evaluate the workflow's actual publish-row expression.
//
// The `result == 'success'` assertion below is not redundant with the `needs:`
// one. An `if:` containing `!cancelled()`, `always()` or `failure()` stops
// GitHub skipping the job on a failed dependency, so `needs:` alone silently
// fail-opens (the M5 defect); every publish-npm job uses `!cancelled()`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')
const VERIFY_REUSABLE = './.github/workflows/verify-generated-wrappers.yml'
// A per-package pipeline always runs its verify job, so `success` is the only
// passing result.
const GATE = "needs.verify-generated.result == 'success'"
// The consolidated pipeline runs one matrix verify job for whichever packages
// this run selected, so it must also tolerate `skipped`, which happens only when
// the run selected no gated package at all. `success` alone would make every
// non-gated package unpublishable. Both failure modes still block.
const GATE_MATRIX =
  "needs.verify-generated.result != 'failure' && needs.verify-generated.result != 'cancelled'"
const CONSOLIDATED = '.github/workflows/on-merge-nx.yml'
const NO_PUBLISH_TEST_PACKAGES = ['decoder-audio', 'asr-ggml', 'bci-whispercpp', 'tts-ggml', 'audiogen-ggml', 'ocr-ggml', 'translation-nmtcpp']

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

// The negative assertions below must see code only: a comment may legitimately
// name a privilege the workflow must not hold.
function withoutComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s#.*$/, ''))
    .join('\n')
}

function eachJob(source) {
  const jobsIdx = source.search(/^jobs:\s*$/m)
  if (jobsIdx === -1) return []
  const lines = source.slice(jobsIdx).split('\n')
  const jobs = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (m) {
      if (cur) jobs.push(cur)
      cur = { name: m[1], text: '' }
      continue
    }
    if (/^\S/.test(line) && cur) {
      jobs.push(cur)
      cur = null
    }
    if (cur) cur.text += line + '\n'
  }
  if (cur) jobs.push(cur)
  return jobs
}

// A wrapper pipeline is any on-merge-*.yml that calls the verify reusable.
// Derived so a new pipeline cannot opt out of these assertions by omission.
function wrapperPipelines() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /^on-merge-.*\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
    .filter((path) => read(path).includes(`uses: ${VERIFY_REUSABLE}`))
}

// Publish jobs are identified by what they do -- invoking a publish action --
// rather than by name, so a differently named job (e.g. publish-release-npm)
// is still covered.
function publishJobs(source) {
  return eachJob(source).filter((job) => /uses:.*publish-library-to-(gpr|npm)/.test(job.text))
}

// The `if:` value, flattened to one line. Both `>-` and `|` styles appear.
function ifExpression(jobText) {
  const m = jobText.match(/^ {4}if:[ \t]*[|>][-+]?[ \t]*\n((?: {6}.*\n|\n)*)/m)
  if (m) return m[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
  const inline = jobText.match(/^ {4}if:[ \t]*(.+)$/m)
  return inline ? inline[1].trim() : null
}

test('RAG release publishing requires a successful build, release authorization and an uncancelled run', () => {
  const job = eachJob(read('.github/workflows/trigger-reusable-lib-rag.yml'))
    .find((job) => job.name === 'publish-release-npm')
  assert.ok(job)
  const expression = ifExpression(job.text)
  assert.ok(expression)
  const evaluate = new Function(
    'needs',
    'cancelled',
    `return ${expression.replace(/needs\.([\w-]+)/g, (_, name) => `needs[${JSON.stringify(name)}]`)}`,
  )

  for (const build of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const guard of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const release of ['true', 'false']) {
        const needs = {
          build: { result: build },
          'release-merge-guard': { result: guard },
          'publish-logic': { outputs: { publish_release: release } },
        }
        for (const runCancelled of [false, true]) {
          assert.equal(
            evaluate(needs, () => runCancelled),
            !runCancelled && build === 'success' && ['success', 'skipped'].includes(guard) && release === 'true',
            `cancelled=${runCancelled}, build=${build}, guard=${guard}, release=${release}`,
          )
        }
      }
    }
  }
})

// The packages the consolidated pipeline publishes, read from its own push paths
// so the list cannot drift from the workflow.
function consolidatedPackages() {
  return [...read(CONSOLIDATED).matchAll(/^ {6}- "packages\/([^/]+)\/\*\*"$/gm)].map((m) => m[1])
}

// Packages requiring the gate: an on-merge addon that has generated wrappers.
//
// Both halves are read from the packages themselves, never from the workflow
// under test, or removing a package from that workflow would remove it from this
// list too and the coverage assertion below could never fail.
//
// Script detection comes from the trusted default branch, not the pushed ref.
function gatedPackages() {
  const packagesDir = join(root, 'packages')
  return readdirSync(packagesDir).filter((name) => {
    const projectJson = join(packagesDir, name, 'project.json')
    const packageJson = join(packagesDir, name, 'package.json')
    if (!existsSync(projectJson) || !existsSync(packageJson)) return false
    const onMerge = JSON.parse(readFileSync(projectJson, 'utf8'))?.targets?.['on-merge']
    const hasGeneratedWrappers = Boolean(
      JSON.parse(readFileSync(packageJson, 'utf8'))?.scripts?.['check:generated'],
    )
    return Boolean(onMerge) && hasGeneratedWrappers
  })
}

// Coverage, not pipeline count. The nine per-package on-merge-<pkg>.yml files
// collapse into on-merge-nx.yml, so counting pipelines stopped meaning anything;
// what still has to hold is that every package requiring the gate is reached by
// one. Derived from project.json so a package cannot opt out by omission.
test('every package with generated wrappers is covered by a pipeline', () => {
  const gated = gatedPackages()
  assert.ok(
    gated.length >= 13,
    `expected at least thirteen generated-wrapper packages, found ${gated.length}`,
  )

  const pipelines = wrapperPipelines()
  assert.ok(pipelines.length > 0, 'no on-merge pipeline calls the verify reusable')

  const consolidated = pipelines.includes(CONSOLIDATED)
  if (consolidated) {
    // The coverage claim below leans on the consolidated matrix really being
    // driven by the flag, so assert the wiring rather than trusting the name.
    const source = read(CONSOLIDATED)
    assert.match(source, /verify-generated-rows: \$\{\{ steps\.rows\.outputs\.verify-generated-rows \}\}/)
    assert.match(source, /select\(\.verifyGenerated == true\)/)
    // Script detection comes from the trusted ref and overrides package config.
    assert.match(source, /\+ \{verifyGenerated: \$verifyGenerated/)
    assert.match(source, /scripts\["check:generated"\]/)
    assert.ok(source.includes('git show "${CONFIG_REF}:${pj}"'))
    assert.ok(source.includes('git show "${CONFIG_REF}:packages/${pkg}/package.json"'))
    assert.match(
      source,
      /include: \$\{\{ fromJSON\(needs\.detect\.outputs\.verify-generated-rows\) \}\}/,
    )
    // GATE_MATRIX lets `skipped` through. That is only sound because the verify
    // job is skipped on exactly one condition: the run selected no gated package.
    // Any looser `if:` here would turn `skipped` into a hole in the gate.
    assert.match(source, /^ {4}if: needs\.detect\.outputs\.verify-generated-rows != '\[\]'$/m)
  }

  // A gated package is covered by the consolidated pipeline only if that pipeline
  // actually publishes it; otherwise it needs its own on-merge-<pkg>.yml calling
  // the verify reusable. Checking membership rather than the bare `consolidated`
  // flag, so this cannot collapse to an empty filter.
  const published = new Set(consolidatedPackages())
  const offenders = gated.filter((pkg) => {
    if (consolidated && published.has(pkg)) return false
    return !pipelines.includes(`.github/workflows/on-merge-${pkg}.yml`)
  })
  assert.deepEqual(offenders, [])
})

test('every wrapper publish job is gated on verify-generated', () => {
  const offenders = []

  for (const path of wrapperPipelines()) {
    const source = read(path)
    const jobs = publishJobs(source)
    if (jobs.length === 0) offenders.push(`${path}: no publish job found`)

    for (const job of jobs) {
      const needsBlock = job.text.match(/^ {4}needs:[ \t]*(\[.*\]|(?:\n(?: {6}- .*|\n))*)/m)
      const needs = needsBlock ? needsBlock[0] : ''
      if (!/\bverify-generated\b/.test(needs)) {
        offenders.push(`${path}::${job.name}: verify-generated missing from needs`)
      }

      const cond = ifExpression(job.text)
      if (cond === null) {
        offenders.push(`${path}::${job.name}: has no if: condition to carry the gate`)
        continue
      }
      // The gate must lead and the remainder must be parenthesised, so that a
      // top-level `||` in the original condition cannot out-bind the `&&`.
      const expected = path === CONSOLIDATED ? GATE_MATRIX : GATE
      if (!cond.startsWith(`${expected} &&`)) {
        offenders.push(`${path}::${job.name}: if: must lead with "${expected} &&"`)
        continue
      }
      const remainder = cond.slice(expected.length).trim().replace(/^&&/, '').trim()
      if (!(remainder.startsWith('(') && remainder.endsWith(')'))) {
        offenders.push(
          `${path}::${job.name}: condition after the gate must be wrapped in parentheses ` +
            `(&& binds tighter than ||)`,
        )
      }
    }
  }

  assert.deepEqual(offenders, [])
})

test('the verify job stays unprivileged and secretless', () => {
  const source = withoutComments(read('.github/workflows/verify-generated-wrappers.yml'))

  // Untrusted code (npm install of the package tree, then tsc) runs here. It
  // must not gain publish privilege, or gating on it is pointless.
  assert.match(source, /^permissions:\n {2}contents: read\n/m)
  assert.doesNotMatch(source, /id-token:\s*write/)
  assert.doesNotMatch(source, /contents:\s*write/)
  assert.doesNotMatch(source, /PAT_TOKEN|NPM_TOKEN|secrets\./)
  assert.match(source, /persist-credentials: false/)
  // --if-present would let a renamed script silently pass the gate.
  assert.match(source, /run: npm run check:generated\s*$/m)
  assert.doesNotMatch(source, /check:generated --if-present/)
})

test('callers grant the verify job no more than contents: read', () => {
  const offenders = []

  for (const path of wrapperPipelines()) {
    for (const job of eachJob(read(path))) {
      if (!job.text.includes(`uses: ${VERIFY_REUSABLE}`)) continue
      if (!/^ {4}permissions:\n {6}contents: read\n/m.test(job.text)) {
        offenders.push(`${path}::${job.name}: caller must declare permissions: contents: read`)
      }
      if (/^ {4}secrets:/m.test(job.text)) {
        offenders.push(`${path}::${job.name}: caller must not pass secrets to the verify job`)
      }
    }
  }

  assert.deepEqual(offenders, [])
})

test('wrapper drift is still checked somewhere at PR time', () => {
  // The merge-time job covers push/dispatch; sanity-checks covers PRs. Losing
  // the PR-time half would push every drift failure to after the merge.
  const sanityChecks = read('.github/actions/sanity-checks/action.yaml')
  assert.match(sanityChecks, /check:generated/)
})

test('speech, OCR and translation publishing retains wrapper verification without integration or mobile E2E tests', () => {
  const source = withoutComments(read(CONSOLIDATED))
  const jobs = eachJob(source)

  for (const name of NO_PUBLISH_TEST_PACKAGES) {
    const project = JSON.parse(read(`packages/${name}/project.json`))
    const config = project.targets['on-merge'].options.ci
    assert.equal(config.testGateMode, 'none', name)
    assert.equal(config.verifyGenerated, true, name)
    assert.notEqual(config.postIntegrationOnGpr, true, name)

    assert.ok(!jobs.some((job) => job.text.includes(`uses: ./.github/workflows/integration-mobile-test-${name}.yml`)),
      `${name}: publishing must not call mobile E2E tests`)

    assert.ok(project.targets['test:integration'], `${name}: keep the integration test target`)
    assert.match(read(`.github/workflows/integration-mobile-test-${name}.yml`), /^ {2}workflow_dispatch:/m,
      `${name}: keep mobile tests available on demand`)
  }

  assert.doesNotMatch(source, /mobile-gate-decoder-audio/)
  for (const job of publishJobs(source)) {
    const needs = job.text.match(/^ {4}needs:\n((?: {6}- .*\n)*)/m)
    assert.ok(needs, `${job.name}: missing publish dependencies`)
    assert.doesNotMatch(needs[1], /mobile|post-build-gate|post-publish/)
  }
})

test('publish rows preserve wrapper verification while honoring integration test opt-outs', () => {
  for (const name of consolidatedPackages()) {
    const project = JSON.parse(read(`packages/${name}/project.json`))
    const config = project.targets['on-merge'].options.ci
    const manifest = `packages/${name}/package.json`
    const hasCheck = existsSync(join(root, manifest)) && Boolean(JSON.parse(read(manifest)).scripts?.['check:generated'])
    const row = publishRow(name, config, hasCheck, Boolean(project.targets.build), project.root)

    assert.equal(row.verifyGenerated, hasCheck, name)
    assert.equal(row.hasPrebuilds, Boolean(project.targets.build), `${name}: preserve prebuild selection`)
    if (NO_PUBLISH_TEST_PACKAGES.includes(name)) {
      assert.equal(row.testGateMode, 'none', name)
      assert.ok(!project.targets.build?.options?.ci?.desktopSmokeCommand, `${name}: no prebuild smoke tests`)
    }
  }
})

// Evaluate workflow code so synthetic opt-ins cover the otherwise unused paths.
function publishRow(name, config, hasCheck = true, hasPrebuilds = true, workdir = `packages/${name}`) {
  const expression = read(CONSOLIDATED).match(/row=\$\(jq -n[\s\S]*?\n\s+'([\s\S]*?)'\)/)?.[1]
  assert.ok(expression, 'missing publish row construction')
  return JSON.parse(execFileSync('jq', [
    '-n', '--arg', 'pkg', name, '--arg', 'workdir', workdir,
    '--argjson', 'hasPrebuilds', String(hasPrebuilds),
    '--argjson', 'verifyGenerated', String(hasCheck),
    '--argjson', 'onmerge', JSON.stringify(config), expression,
  ], { encoding: 'utf8' }))
}

function integrationRows(variable, rows) {
  const line = read(CONSOLIDATED).split('\n').find((line) => line.trimStart().startsWith(`${variable}=`))
  const expression = line?.match(/jq -c '([^']+)'/)?.[1]
  assert.ok(expression, `missing ${variable} selector`)
  return JSON.parse(execFileSync('jq', ['-c', expression], {
    input: JSON.stringify(rows), encoding: 'utf8',
  }))
}

function runGate(job, stepMarker, env) {
  const stepStart = job.text.indexOf(stepMarker)
  assert.notEqual(stepStart, -1, `${job.name}: missing ${stepMarker}`)
  const script = job.text.slice(stepStart).match(/        run: \|\n((?: {10}[^\n]*\n|\n)+)/)?.[1]
  assert.ok(script, `${job.name}: missing gate script`)
  const dir = mkdtempSync(join(tmpdir(), 'publish-gate-'))
  const output = join(dir, 'output')
  try {
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, ...env, GITHUB_OUTPUT: output }, encoding: 'utf8',
    })
    assert.ifError(result.error)
    return {
      status: result.status,
      outputs: existsSync(output) ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      })) : {},
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('package config cannot override derived wrapper verification', () => {
  for (const hasCheck of [true, false]) {
    for (const config of [{}, { verifyGenerated: true }, { verifyGenerated: false }]) {
      assert.equal(publishRow('synthetic', config, hasCheck).verifyGenerated, hasCheck)
    }
  }
})

test('synthetic pre-publish opt-ins reach integration and both registry publish gates', () => {
  const optedIn = publishRow('synthetic-pre', { testGateMode: 'pre-publish-integration' })
  const rows = integrationRows('pre_publish_rows', [
    optedIn,
    publishRow('synthetic-none', { testGateMode: 'none' }),
    publishRow('synthetic-post', { testGateMode: 'post-publish-integration' }),
  ])
  assert.deepEqual(rows, [optedIn])
  const jobs = eachJob(read(CONSOLIDATED))
  const integration = jobs.find((job) => job.name === 'pre-publish-integration')
  assert.ok(integration)
  assert.match(integration.text, /include: \$\{\{ fromJSON\(needs\.detect\.outputs\.pre-publish-rows\) \}\}/)
  assert.match(integration.text, /uses: \.\/\.github\/workflows\/integration-test-nx\.yml/)
  for (const name of ['publish-npm', 'publish-gpr']) {
    const job = jobs.find((job) => job.name === name)
    assert.ok(job)
    assert.match(job.text, /^ {6}- pre-publish-integration$/m)
    assert.match(job.text, /if: startsWith\(matrix\.testGateMode, 'pre-publish'\)/)
    assert.match(job.text, /INTEGRATION_RESULT: \$\{\{ needs\.pre-publish-integration\.result \}\}/)
    for (const [result, status] of [['success', 0], ['failure', 1], ['cancelled', 1]]) {
      const actual = runGate(job, "- name: Enforce this package's pre-publish test gate", {
        PACKAGE: rows[0].package, INTEGRATION_RESULT: result,
      })
      assert.equal(actual.status, status, `${name}: ${result}`)
    }
  }
})

test('synthetic post-publish opt-ins require a successful publish and honor the GPR opt-in', () => {
  const npmOnly = publishRow('synthetic-npm', { testGateMode: 'post-publish-integration' })
  const both = publishRow('synthetic-both', { testGateMode: 'post-publish-integration', postIntegrationOnGpr: true })
  const rows = integrationRows('post_integration_rows', [
    npmOnly, both, publishRow('synthetic-none', { testGateMode: 'none', postIntegrationOnGpr: true }),
    publishRow('synthetic-pre', { testGateMode: 'pre-publish-integration' }),
  ])
  assert.deepEqual(rows, [npmOnly, both])
  const jobs = eachJob(read(CONSOLIDATED))
  const gate = jobs.find((job) => job.name === 'post-build-gate')
  assert.ok(gate)
  assert.match(gate.text, /ROWS: \$\{\{ needs\.detect\.outputs\.post-integration-rows \}\}/)
  assert.match(gate.text, /NPM_RESULT: \$\{\{ needs\.publish-npm\.result \}\}/)
  assert.match(gate.text, /GPR_RESULT: \$\{\{ needs\.publish-gpr\.result \}\}/)
  for (const [npm, gpr, input, expected] of [
    ['success', 'skipped', rows, rows],
    ['success', 'success', rows, rows],
    ['skipped', 'success', rows, [both]],
    ['skipped', 'success', [npmOnly], []],
    ['failure', 'failure', rows, []],
    ['cancelled', 'skipped', rows, []],
    ['skipped', 'skipped', rows, []],
    ['success', 'skipped', [], []],
  ]) {
    const actual = runGate(gate, '- id: gate', {
      NPM_RESULT: npm, GPR_RESULT: gpr, ROWS: JSON.stringify(input),
    })
    assert.equal(actual.status, 0)
    assert.deepEqual(JSON.parse(actual.outputs.rows), expected, `npm=${npm} gpr=${gpr}`)
    assert.equal(actual.outputs.should_run_tests, String(expected.length > 0))
  }
  const integration = jobs.find((job) => job.name === 'post-publish-integration')
  assert.ok(integration)
  assert.match(integration.text, /needs\.post-build-gate\.outputs\.should_run_tests == 'true'/)
  assert.match(integration.text, /include: \$\{\{ fromJSON\(needs\.post-build-gate\.outputs\.rows\) \}\}/)
  assert.match(integration.text, /uses: \.\/\.github\/workflows\/integration-test-nx\.yml/)
})
