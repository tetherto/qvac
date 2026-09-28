// Every job that calls a mobile leaf must grant `actions: read`, which the
// leaves need to download another run's prebuilds. A reusable workflow cannot
// hold more permission than its caller grants, and GitHub only checks when a
// caller runs — dispatching a leaf directly never exercises one, which is how
// three on-merge workflows went to startup_failure unnoticed.
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

// Any job declaring it, not just build-and-test: keying on a job name meant a
// rename silently dropped the leaf and stopped checking all of its callers.
function leavesNeedingActionsRead() {
  return new Set(
    workflows().filter((name) => {
      if (!name.startsWith('integration-mobile-test-')) return false
      return Object.values(jobPerms(read(name))).some((perms) => perms.actions !== undefined)
    }),
  )
}

function jobStarts(lines) {
  return lines.reduce((acc, line, i) => {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) acc.push(i)
    return acc
  }, [])
}

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

      // Whole job span, not forward from `uses:`: most callers put
      // `permissions:` above it, and a job block overrides the workflow one.
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
  assert.ok(found.length >= 16, `expected at least 16 caller jobs, found ${found.length}`)
})

// `actions: none` is valid YAML and grants nothing, so an absent key is not the
// only way to fail. Require a level that actually reads.
const READS = new Set(['read', 'write'])

test('every caller of a mobile leaf grants actions: read', () => {
  const gaps = mobileCalls()
    .filter(({ granted }) => !granted || !READS.has(granted.actions))
    .map(({ caller, job, target, granted }) =>
      `${caller} job '${job}' calls ${target} with actions: ${granted?.actions ?? 'unset'}`)

  assert.deepEqual(
    gaps,
    [],
    'these caller jobs do not grant `actions: read`, so the leaf cannot read the ' +
      'run it downloads prebuilds from and GitHub aborts the run before any job ' +
      'starts:\n  ' + gaps.join('\n  '),
  )
})
