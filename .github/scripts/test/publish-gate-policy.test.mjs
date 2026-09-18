// Locks the wrapper-drift gate on the publish pipelines. Nothing else can:
// on-merge-* never runs on a pull request, and actionlint checks structure,
// not semantics.
//
// The expected set is derived from the *packages* -- every on-merge-*.yml that
// invokes a publish action for a package defining `check:generated` -- and
// deliberately NOT from which workflows already call the verify reusable. An
// earlier revision filtered on the latter, which is the very property these
// tests assert: the list could never contain a pipeline that omitted the gate,
// so three wrapper publishers stayed ungated without failing anything.
// Filtering a conformance list on the conformance property makes the
// assertions vacuous.
//
// The `result == 'success'` assertion below is not redundant with the `needs:`
// one. An `if:` containing `!cancelled()`, `always()` or `failure()` stops
// GitHub skipping the job on a failed dependency, so `needs:` alone silently
// fail-opens (the M5 defect); every publish-npm job uses `!cancelled()`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')
const VERIFY_REUSABLE = './.github/workflows/verify-generated-wrappers.yml'
const GATE = "needs.verify-generated.result == 'success'"

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

// Every merge-triggered pipeline, gated or not. The gate must never take part
// in building this list -- see the header.
function onMergeWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /^on-merge-.*\.ya?ml$/.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`)
}

// Publish jobs are identified by what they do -- invoking a publish action --
// rather than by name, so a differently named job (e.g. publish-release-npm)
// is still covered.
function publishJobs(source) {
  return eachJob(source).filter((job) => /uses:.*publish-library-to-(gpr|npm)/.test(job.text))
}

function unquote(value) {
  return value.replace(/^["']/, '').replace(/["']$/, '')
}

// Job-level `env:` only (four-space key, six-space entries). Step-level env
// blocks are indented deeper and must not leak into the lookup.
function jobEnv(jobText) {
  const env = new Map()
  const block = jobText.match(/^ {4}env:\n((?: {6}[A-Za-z_][A-Za-z0-9_]*:.*\n)*)/m)
  if (!block) return env
  for (const line of block[1].split('\n')) {
    const entry = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*?)[ \t]*$/)
    if (entry) env.set(entry[1], unquote(entry[2]))
  }
  return env
}

// The package directory a job acts on, read off the `workdir:` it hands the
// publish action. Several pipelines pass that as `${{ env.PKG_DIR }}` or
// `${{ env.WORKDIR }}`, so job-level env is resolved first. The filename is
// not a usable substitute: on-merge-vla.yml publishes packages/vla-ggml.
function packageDirs(jobText) {
  const env = jobEnv(jobText)
  const dirs = new Set()
  for (const match of jobText.matchAll(/^\s*workdir:[ \t]*(.+?)[ \t]*$/gm)) {
    let value = unquote(match[1])
    const expression = value.match(/^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/)
    if (expression) value = env.get(expression[1]) ?? ''
    if (/^packages\/[^/]+$/.test(value)) dirs.add(value)
  }
  return [...dirs]
}

// A package with no `check:generated` has no committed tsc output to drift
// (e.g. fabric), and gating its publish on the reusable would only fail the
// verify job on a missing npm script.
function definesCheckGenerated(packageDir) {
  const manifestPath = join(root, packageDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return typeof manifest.scripts?.['check:generated'] === 'string'
}

// Package-derived, so a new wrapper publisher is covered the moment it lands
// and cannot opt out of the assertions below by omitting the gate.
function wrapperPipelines() {
  return onMergeWorkflows().filter((path) =>
    publishJobs(read(path)).some((job) => packageDirs(job.text).some(definesCheckGenerated)),
  )
}

// The `if:` value, flattened to one line. Both `>-` and `|` styles appear.
function ifExpression(jobText) {
  const m = jobText.match(/^ {4}if:[ \t]*[|>][-+]?[ \t]*\n((?: {6}.*\n|\n)*)/m)
  if (m) return m[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
  const inline = jobText.match(/^ {4}if:[ \t]*(.+)$/m)
  return inline ? inline[1].trim() : null
}

// Guards the derivation itself. If `packageDirs` silently resolved nothing --
// a renamed input, a new indirection -- `wrapperPipelines()` would quietly
// empty out and every assertion below would pass while gating nothing.
test('every on-merge publish job resolves to exactly one package directory', () => {
  const offenders = []

  for (const path of onMergeWorkflows()) {
    for (const job of publishJobs(read(path))) {
      const dirs = packageDirs(job.text)
      if (dirs.length !== 1) {
        offenders.push(`${path}::${job.name}: resolved ${dirs.length} package dirs (${dirs})`)
        continue
      }
      if (!existsSync(join(root, dirs[0], 'package.json'))) {
        offenders.push(`${path}::${job.name}: ${dirs[0]}/package.json does not exist`)
      }
    }
  }

  assert.deepEqual(offenders, [])
})

test('wrapper publish pipelines are discovered', () => {
  const pipelines = wrapperPipelines()
  assert.ok(
    pipelines.length >= 13,
    `expected at least the thirteen wrapper publish pipelines, found ${pipelines.length}: ${pipelines}`,
  )
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
      if (!cond.includes(GATE)) {
        offenders.push(`${path}::${job.name}: if: does not test ${GATE}`)
        continue
      }
      // The gate must lead and the remainder must be parenthesised, so that a
      // top-level `||` in the original condition cannot out-bind the `&&`.
      if (!cond.startsWith(`${GATE} &&`)) {
        offenders.push(`${path}::${job.name}: gate must be the leading clause of if:`)
      }
      const remainder = cond.slice(cond.indexOf('&&') + 2).trim()
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

// The converse of the gating test: a pipeline wired to the reusable for a
// package with no `check:generated` would fail the verify job on every run,
// because the reusable deliberately runs the script without --if-present.
test('every pipeline calling the verify reusable has a check:generated to run', () => {
  const offenders = []

  for (const path of onMergeWorkflows()) {
    const source = read(path)
    if (!source.includes(`uses: ${VERIFY_REUSABLE}`)) continue

    for (const job of eachJob(source)) {
      if (!job.text.includes(`uses: ${VERIFY_REUSABLE}`)) continue
      const dirs = packageDirs(job.text)
      if (dirs.length !== 1) {
        offenders.push(`${path}::${job.name}: verify caller resolved ${dirs.length} workdirs`)
        continue
      }
      if (!definesCheckGenerated(dirs[0])) {
        offenders.push(`${path}::${job.name}: ${dirs[0]} defines no check:generated script`)
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

  for (const path of onMergeWorkflows()) {
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

// A drift check that cannot see untracked files passes on an emitted wrapper
// that was never committed. `git status --porcelain --untracked-files=all`
// sees it; `git diff --exit-code` does not.
test('every check:generated script observes untracked output', () => {
  const offenders = []
  const seen = new Set()

  for (const path of wrapperPipelines()) {
    for (const job of publishJobs(read(path))) {
      for (const dir of packageDirs(job.text)) {
        if (seen.has(dir)) continue
        seen.add(dir)
        const manifest = JSON.parse(read(join(dir, 'package.json')))
        const script = manifest.scripts?.['check:generated']
        if (!script) continue
        // Delegating to a script file is fine; those assert tracked-ness
        // themselves (see packages/*/scripts/check-generated.mjs).
        if (/\bnode\b[^&|]*check-generated/.test(script)) continue
        if (/git diff\b/.test(script)) {
          offenders.push(`${dir}: check:generated uses git diff, which cannot see untracked files`)
        }
        if (!/--untracked-files=all/.test(script)) {
          offenders.push(`${dir}: check:generated must pass --untracked-files=all`)
        }
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
