// Locks the wrapper-drift gate on the publish pipelines. Nothing else can:
// on-merge-* never runs on a pull request, and actionlint checks structure,
// not semantics.
//
// The `result == 'success'` assertion below is not redundant with the `needs:`
// one. An `if:` containing `!cancelled()`, `always()` or `failure()` stops
// GitHub skipping the job on a failed dependency, so `needs:` alone silently
// fail-opens (the M5 defect); every publish-npm job uses `!cancelled()`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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

test('wrapper publish pipelines are discovered', () => {
  const pipelines = wrapperPipelines()
  assert.ok(
    pipelines.length >= 9,
    `expected at least the nine TypeScript-wrapper pipelines, found ${pipelines.length}`,
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
