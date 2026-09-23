// Every job that calls a mobile leaf must grant `actions: read`.
//
// The leaves' build-and-test job reads another run and downloads its artifact
// for prebuild_run_id (QVAC-24335), so it declares `actions: read`. A reusable
// workflow cannot hold more permission than the job calling it grants, and
// build-and-test always runs under workflow_call — validate-devices is the job
// that gets skipped there, not this one.
//
// Nothing caught this when the permission was added: GitHub only checks when a
// caller runs, and the 28 Device Farm runs used to validate that change were
// dispatched straight at the leaves, where there is no caller. Three on-merge
// workflows went from success to startup_failure three seconds after the merge
// and stayed there.
//
// Deliberately narrow. A general "caller covers everything the callee requests"
// check reports calls that work today, because a leaf's other jobs declare
// permissions their callers never grant and are skipped or tolerated in that
// context. This asserts the one permission whose absence is known to abort the
// run, rather than a model of the rule that the tree contradicts.
//
// Indentation-scoped, not YAML-parsed: these suites run on bare node with no
// dependencies, matching the others in this directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')

const workflows = () => readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))
const read = (name) => readFileSync(join(WORKFLOW_DIR, name), 'utf8').split('\n')

// Entries of the permissions block whose key sits at `indent`.
function permsAt(lines, start, indent) {
  const entries = {}
  for (let i = start + 1; i < lines.length; i++) {
    if (!new RegExp(`^ {${indent + 2}}\\S`).test(lines[i])) break
    const m = lines[i].trim().match(/^([a-z-]+):\s*(\S+)$/)
    if (m) entries[m[1]] = m[2]
  }
  return entries
}

function workflowPerms(lines) {
  const i = lines.findIndex((l) => /^permissions:\s*$/.test(l))
  return i === -1 ? null : permsAt(lines, i, 0)
}

// Leaves where ANY job declares actions: read. Not pinned to the job name:
// keying on 'build-and-test' meant renaming that job, or a different job in a
// leaf gaining the permission, silently dropped the leaf from the checked set
// and stopped verifying every one of its callers. Over-requiring a grant is
// safe; missing one aborts the run.
function leavesNeedingActionsRead() {
  return new Set(
    workflows().filter((name) => {
      if (!name.startsWith('integration-mobile-test-')) return false
      return Object.values(jobPerms(read(name))).some((perms) => perms.actions !== undefined)
    }),
  )
}

// Line indexes where a job key starts, so a job's span is [start, next start).
function jobStarts(lines) {
  return lines.reduce((acc, line, i) => {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) acc.push(i)
    return acc
  }, [])
}

// { jobId: {scope: level} } for every job-level permissions block.
function jobPerms(lines) {
  const out = {}
  let job = null
  lines.forEach((line, i) => {
    const jm = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (jm) job = jm[1]
    if (job && /^ {4}permissions:\s*$/.test(line)) out[job] = permsAt(lines, i, 4)
  })
  return out
}

// Each local call to a mobile leaf, with the calling job's effective grant.
function mobileCalls() {
  const need = leavesNeedingActionsRead()
  const found = []
  for (const name of workflows()) {
    const lines = read(name)
    const wf = workflowPerms(lines)
    lines.forEach((line, i) => {
      const m = line.match(/uses:\s*\.\/\.github\/workflows\/(integration-mobile-test-[\w.-]+\.ya?ml)/)
      if (!m || !need.has(m[1])) return
      let job = '?'
      for (let j = i; j >= 0; j--) {
        const jm = lines[j].match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
        if (jm) { job = jm[1]; break }
      }

      // Search the WHOLE job, not forward from `uses:`. YAML mapping order is
      // free and 16 of the callers put `permissions:` above `uses:`; scanning
      // forward missed those and fell back to the workflow-level block, which
      // a job-level block overrides outright. That reported a grant the job
      // does not have — fail-open, in the one direction this test guards.
      const starts = jobStarts(lines)
      const jobStart = Math.max(...starts.filter((s) => s <= i))
      const jobEnd = Math.min(...starts.filter((s) => s > jobStart), lines.length)
      let granted = null
      for (let j = jobStart; j < jobEnd; j++) {
        if (/^ {4}permissions:\s*$/.test(lines[j])) { granted = permsAt(lines, j, 4); break }
      }
      found.push({ caller: name, job, target: m[1], granted: granted ?? wf })
    })
  }
  return found
}

test('discovery finds the leaves and their callers', () => {
  const need = leavesNeedingActionsRead()
  assert.ok(need.size >= 12, `expected at least 12 leaves needing actions: read, found ${need.size}`)
  const found = mobileCalls()
  assert.ok(found.length >= 20, `expected at least 20 caller jobs, found ${found.length}`)
})

test('every caller of a mobile leaf grants actions: read', () => {
  const gaps = mobileCalls()
    .filter(({ granted }) => !granted || granted.actions === undefined)
    .map(({ caller, job, target }) => `${caller} job '${job}' calls ${target}`)

  assert.deepEqual(
    gaps,
    [],
    'these caller jobs do not grant `actions: read`, so the leaf cannot read the ' +
      'run it downloads prebuilds from and GitHub aborts the run before any job ' +
      'starts:\n  ' + gaps.join('\n  '),
  )
})
