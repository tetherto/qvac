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
const definitions = () => workflows().map((name) => ({ name, lines: read(name) }))

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
function leavesNeedingActionsRead(sources = definitions()) {
  return new Set(
    sources.filter(({ name, lines }) => {
      if (!name.startsWith('integration-mobile-test-')) return false
      return Object.values(jobPerms(lines)).some((perms) => perms.actions !== undefined)
    }).map(({ name }) => name),
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

function mobileCalls(sources = definitions()) {
  const need = leavesNeedingActionsRead(sources)
  const found = []
  for (const { name, lines } of sources) {
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
  // The nx migration removed the per-addon callers. Assert their actual
  // replacements instead of a pre-migration global job-count threshold.
  for (const addon of ['asr-ggml', 'bci-whispercpp', 'tts-ggml']) {
    assert.ok(found.some(({ caller, job, target }) =>
      caller === 'on-merge-nx.yml' &&
      job === `mobile-post-publish-${addon}` &&
      target === `integration-mobile-test-${addon}.yml`
    ), `missing consolidated post-publish caller for ${addon}`)
  }
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

// Exercise discovery independently of how many workflows the repository has.
test('discovery retains inherited permissions and a job-level denial', () => {
  const sources = [
    {
      name: 'integration-mobile-test-fixture.yml',
      lines: ['jobs:', '  build:', '    permissions:', '      actions: read'],
    },
    {
      name: 'caller.yml',
      lines: [
        'permissions:', '  actions: read', 'jobs:',
        '  inherited:',
        '    uses: ./.github/workflows/integration-mobile-test-fixture.yml',
        '  denied:', '    permissions:', '      actions: none',
        '    uses: ./.github/workflows/integration-mobile-test-fixture.yml',
      ],
    },
  ]
  const calls = mobileCalls(sources)
  assert.deepEqual(calls.map(({ job, granted }) => ({ job, granted })), [
    { job: 'inherited', granted: { actions: 'read' } },
    { job: 'denied', granted: { actions: 'none' } },
  ])
  assert.deepEqual(calls.filter(({ granted }) => !READS.has(granted.actions)).map(({ job }) => job), ['denied'])
})
