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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')
const VERIFY_REUSABLE = './.github/workflows/verify-generated-wrappers.yml'
// A per-package pipeline always runs its verify job, so `success` is the only
// passing result.
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

const isContract = (project) => Boolean(project?.tags?.includes('ci:contract'))

// Packages requiring the gate: an on-merge or CI contract addon that has generated wrappers.
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
    const project = JSON.parse(readFileSync(projectJson, 'utf8'))
    const hasGeneratedWrappers = Boolean(
      JSON.parse(readFileSync(packageJson, 'utf8'))?.scripts?.['check:generated'],
    )
    return Boolean(project?.targets?.['on-merge'] || isContract(project)) && hasGeneratedWrappers
  })
}

// Coverage, not pipeline count: every package requiring the gate is reached by a pipeline. Derived from project.json
// so a package cannot opt out by omission.
test('every package with generated wrappers is covered by a pipeline', () => {
  const gated = gatedPackages()
  assert.ok(
    gated.length >= 13,
    `expected at least thirteen generated-wrapper packages, found ${gated.length}`,
  )

  const pipelines = wrapperPipelines()

  // A package on the CI contract is covered when it declares verify:generated, which publish-npm.yml runs before it
  // publishes; any other gated package needs its own on-merge-<pkg>.yml calling the verify reusable.
  const contractVerifies = /^ {6}targets: build,verify:generated,verify:deps,publish$/m.test(read('.github/workflows/publish-npm.yml'))
  const offenders = gated.filter((pkg) => {
    const project = JSON.parse(read(`packages/${pkg}/project.json`))
    if (isContract(project)) return !(contractVerifies && project.targets['verify:generated'])
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
      const expected = GATE
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

