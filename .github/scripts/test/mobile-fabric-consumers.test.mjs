// Guards mobile-test-fabric-consumers.yml, the one-run Device Farm validation of
// a fabric change across every fabric consumer.
//
// It is dispatch-only, and workflow_dispatch only runs from the default branch,
// so no PR run exercises it. These assertions are the only pre-merge check: a
// consumer that drops out of the caller, a run id wired to the wrong input, or a
// permission the called workflow needs and the caller does not grant would all
// surface only after merge, as a missing suite or a startup_failure.
//
// Text-parsed, not YAML-parsed: the trust-policy job runs `node --test` with no
// npm install.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')
const CALLER = 'mobile-test-fabric-consumers.yml'
const LEAF_PREFIX = 'integration-mobile-test-'
const RESOLVE_STEP = 'Resolve consumers and prebuild sources'

// Which caller input feeds each consumer's prebuild_run_id. Every consumer not
// listed takes the nx run.
const OWN_PREBUILD_INPUT = {
  'classification-ggml': 'classification_prebuild_run_id',
  vla: 'vla_prebuild_run_id',
}
const prebuildInputFor = (slug) => OWN_PREBUILD_INPUT[slug] ?? 'nx_prebuild_run_id'

const read = (name) => readFileSync(join(WORKFLOW_DIR, name), 'utf8')

function topLevelBlock(source, key) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === `  ${key}:`)
  if (start === -1) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

function jobs(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === 'jobs:')
  const out = new Map()
  let current = null
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (match) {
      current = match[1]
      out.set(current, [])
      continue
    }
    if (current) out.get(current).push(lines[i])
  }
  return new Map([...out].map(([name, body]) => [name, body.join('\n')]))
}

// A `permissions:` mapping at the given indent; comment lines inside it are
// skipped rather than ending the block.
function permissionsAt(text, indent) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === `${' '.repeat(indent)}permissions:`)
  if (start === -1) return null
  const out = {}
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue
    const match = lines[i].match(new RegExp(`^ {${indent + 2}}([a-z-]+):\\s*(\\S+)`))
    if (!match) break
    out[match[1]] = match[2]
  }
  return out
}

const RANK = { none: 0, read: 1, write: 2 }

// Everything a called workflow's jobs request, following nested local calls.
// GitHub checks this against the caller's grant when the run starts, including
// jobs whose `if:` will skip them.
function requestedPermissions(name, seen = new Set()) {
  if (seen.has(name)) return {}
  seen.add(name)
  const source = read(name)
  const workflowLevel = permissionsAt(source, 0) ?? {}
  const total = {}
  for (const body of jobs(source).values()) {
    const requested = permissionsAt(body, 4) ?? workflowLevel
    for (const [scope, level] of Object.entries(requested)) {
      if (!(scope in total) || RANK[level] > RANK[total[scope]]) total[scope] = level
    }
    const nested = body.match(/^ {4}uses:\s*\.\/\.github\/workflows\/(\S+)/m)
    if (nested) {
      for (const [scope, level] of Object.entries(requestedPermissions(nested[1], seen))) {
        if (!(scope in total) || RANK[level] > RANK[total[scope]]) total[scope] = level
      }
    }
  }
  return total
}

// Consumers are the mobile workflows that can overlay a PR fabric when called.
function fabricConsumerLeaves() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.startsWith(LEAF_PREFIX) && name.endsWith('.yml'))
    .filter((name) => /^ {6}fabric_prebuild_run_id:$/m.test(topLevelBlock(read(name), 'workflow_call')))
    .map((name) => name.slice(LEAF_PREFIX.length, -'.yml'.length))
    .sort()
}

const caller = read(CALLER)
const callerJobs = jobs(caller)
const calls = [...callerJobs]
  .map(([job, body]) => ({ job, body, target: body.match(/^ {4}uses:\s*\.\/\.github\/workflows\/(\S+)/m)?.[1] }))
  .filter(({ target }) => target?.startsWith(LEAF_PREFIX))

test('the caller runs every fabric consumer and nothing else', () => {
  const consumers = fabricConsumerLeaves()
  assert.ok(consumers.length >= 9, `found ${consumers.length} fabric consumer workflows`)
  const called = calls.map(({ target }) => target.slice(LEAF_PREFIX.length, -'.yml'.length)).sort()
  assert.deepEqual(called, consumers, 'a consumer that accepts fabric_prebuild_run_id must be called, once')

  const listed = extractRunBlock(RESOLVE_STEP).match(/^ALL_CONSUMERS="([^"]+)"/m)?.[1].split(' ').sort()
  assert.deepEqual(listed, consumers, 'ALL_CONSUMERS in the resolve step must match the called workflows')
})

test('each call is gated on its consumer and forwards the fabric and prebuild run ids', () => {
  for (const { job, body, target } of calls) {
    const slug = target.slice(LEAF_PREFIX.length, -'.yml'.length)
    assert.equal(job, slug, `${target} must be called from a job named ${slug}`)
    assert.match(body, /^ {4}needs: resolve$/m, `${slug} must wait for the resolve job`)
    assert.ok(
      body.includes(`if: contains(fromJSON(needs.resolve.outputs.consumers || '[]'), '${slug}')`),
      `${slug} must run only when selected, with an empty-list fallback`,
    )
    assert.match(body, /^ {4}secrets: inherit$/m, `${slug} needs the Device Farm and signing secrets`)
    assert.match(body, /^ {6}fabric_prebuild_run_id: \$\{\{ inputs\.fabric_prebuild_run_id \}\}$/m)
    assert.ok(
      body.includes(`      prebuild_run_id: \${{ inputs.${prebuildInputFor(slug)} }}`),
      `${slug} must take its prebuilds from ${prebuildInputFor(slug)}`,
    )
    assert.match(body, /^ {6}ref: \$\{\{ inputs\.ref \}\}$/m)
  }
})

test('each called consumer accepts prebuild_run_id when called and installs from it', () => {
  for (const { target } of calls) {
    const source = read(target)
    assert.match(
      topLevelBlock(source, 'workflow_call'),
      /^ {6}prebuild_run_id:$/m,
      `${target} must declare prebuild_run_id under workflow_call, or GitHub rejects the caller`,
    )
    assert.ok(source.includes('prebuild-run-id: ${{ inputs.prebuild_run_id }}'), `${target} must pass it to setup`)
  }
})

test('each call grants every permission its consumer requests', () => {
  for (const { job, body, target } of calls) {
    const granted = permissionsAt(body, 4)
    assert.ok(granted, `${job} must declare its own permissions`)
    for (const [scope, level] of Object.entries(requestedPermissions(target))) {
      assert.ok(
        RANK[granted[scope] ?? 'none'] >= RANK[level],
        `${job} grants ${scope}: ${granted[scope] ?? 'none'} but ${target} requests ${scope}: ${level}`,
      )
    }
  }
})

test('the caller is dispatch-only', () => {
  const on = caller.slice(caller.indexOf('\non:\n'), caller.indexOf('\npermissions:\n'))
  assert.match(on, /^ {2}workflow_dispatch:$/m)
  assert.doesNotMatch(on, /pull_request|schedule|push:|workflow_call/, 'Device Farm runs stay on demand')
  assert.match(on, /^ {6}fabric_prebuild_run_id:\n(?: {8}.*\n)*? {8}required: true$/m)
})

// ── resolve step ────────────────────────────────────────────────────────────
// Run the real shell against a fake `gh` that serves artifact listings from
// FAKE_ARTIFACTS ({ runId: [names] }) and records each run id it was asked for.

function extractRunBlock(stepName) {
  const index = caller.indexOf(`- name: ${stepName}`)
  assert.notEqual(index, -1, `step "${stepName}" exists`)
  const rest = caller.slice(index)
  const run = rest.match(/^( *)run: \|\n/m)
  assert.ok(run, `step "${stepName}" has a run block`)
  const indent = run[1].length + 2
  const block = []
  for (const line of rest.slice(run.index + run[0].length).split('\n')) {
    if (line === '') { block.push(''); continue }
    if (!line.startsWith(' '.repeat(indent))) break
    block.push(line.slice(indent))
  }
  return block.join('\n')
}

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const url = process.argv.find((arg) => /actions\\/runs\\/\\d+\\/artifacts/.test(arg)) ?? ''
const run = url.match(/runs\\/(\\d+)\\//)?.[1]
appendFileSync(process.env.FAKE_GH_LOG, run + '\\n')
const artifacts = JSON.parse(process.env.FAKE_ARTIFACTS)
if (!(run in artifacts)) { console.error('HTTP 404: Not Found'); process.exit(1) }
for (const name of artifacts[run]) console.log(name)
`

const NX_BUNDLES = ['embed-llamacpp', 'ggml-rpc-server', 'llm-llamacpp', 'model-fit', 'ocr-ggml', 'translation-nmtcpp', 'turbovec-ggml']
  .map((pkg) => `prebuilds-${pkg}`)
const FULL = {
  1: ['fabric-prebuilds', 'prebuilds-fabric'],
  2: [...NX_BUNDLES, 'prebuilds-cache-pr-1-abc'],
  3: ['prebuilds-classification-ggml'],
  4: ['prebuilds-vla-ggml'],
}
const ALL_IDS = { FABRIC_RUN_ID: '1', NX_RUN_ID: '2', CLASSIFICATION_RUN_ID: '3', VLA_RUN_ID: '4' }

function resolveConsumers(env, artifacts = FULL) {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-fabric-consumers-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  const files = { log: join(dir, 'gh.log'), output: join(dir, 'output'), summary: join(dir, 'summary') }
  for (const file of Object.values(files)) writeFileSync(file, '')
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', extractRunBlock(RESOLVE_STEP)], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      REPO: 'tetherto/qvac',
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      FAKE_GH_LOG: files.log,
      FAKE_ARTIFACTS: JSON.stringify(artifacts),
      FABRIC_RUN_ID: '', NX_RUN_ID: '', CLASSIFICATION_RUN_ID: '', VLA_RUN_ID: '', CONSUMERS: 'all',
      ...env,
    },
  })
  const consumersLine = readFileSync(files.output, 'utf8').match(/^consumers=(.*)$/m)
  const out = {
    status: result.status,
    log: `${result.stdout}${result.stderr}`,
    consumers: consumersLine ? JSON.parse(consumersLine[1]) : null,
    lookups: readFileSync(files.log, 'utf8').split('\n').filter(Boolean),
    summary: readFileSync(files.summary, 'utf8'),
  }
  rmSync(dir, { recursive: true, force: true })
  return out
}

test('resolve: every run id set and every bundle present selects all nine', () => {
  const run = resolveConsumers(ALL_IDS)
  assert.equal(run.status, 0, run.log)
  assert.deepEqual(run.consumers, fabricConsumerLeaves())
  // One listing per run id, however many consumers share it.
  assert.deepEqual([...run.lookups].sort(), ['1', '2', '3', '4'])
  assert.match(run.summary, /- vla: `prebuilds-vla-ggml` from run 4/)
})

test('resolve: a run missing a selected consumer bundle fails before any build', () => {
  const run = resolveConsumers(ALL_IDS, { ...FULL, 2: NX_BUNDLES.filter((name) => name !== 'prebuilds-turbovec-ggml') })
  assert.equal(run.status, 1, run.log)
  assert.match(run.log, /::error::Run 2 from nx_prebuild_run_id has no live 'prebuilds-turbovec-ggml' artifact/)
  assert.equal(run.consumers, null)
})

test('resolve: the fabric run must carry fabric-prebuilds', () => {
  const run = resolveConsumers({ FABRIC_RUN_ID: '2', CONSUMERS: 'llm-llamacpp' })
  assert.equal(run.status, 1, run.log)
  assert.match(run.log, /::error::Run 2 from fabric_prebuild_run_id has no live 'fabric-prebuilds' artifact/)
})

test('resolve: an unreadable run is reported as such', () => {
  const run = resolveConsumers({ ...ALL_IDS, NX_RUN_ID: '99' })
  assert.equal(run.status, 1, run.log)
  assert.match(run.log, /::error::Cannot read run 99 from nx_prebuild_run_id/)
})

test('resolve: malformed inputs fail without calling the API', () => {
  for (const [env, message] of [
    [{ FABRIC_RUN_ID: '' }, /fabric_prebuild_run_id must be a numeric run id/],
    [{ FABRIC_RUN_ID: '1', NX_RUN_ID: '12a' }, /nx_prebuild_run_id must be empty or a numeric run id, got '12a'/],
    [{ FABRIC_RUN_ID: '1', CONSUMERS: 'llm-llamacpp, whisper' }, /Unknown consumer 'whisper'/],
    // `*` would glob into file names if it reached word splitting unchecked.
    [{ FABRIC_RUN_ID: '1', CONSUMERS: '*' }, /consumers may only hold consumer names/],
    [{ FABRIC_RUN_ID: '1', CONSUMERS: 'vla;id' }, /consumers may only hold consumer names/],
  ]) {
    const run = resolveConsumers(env)
    assert.equal(run.status, 1, run.log)
    assert.match(run.log, message)
    assert.deepEqual(run.lookups, [], `no API call for ${JSON.stringify(env)}`)
  }
})

test('resolve: a subset with no prebuild run ids uses the published addons', () => {
  const run = resolveConsumers({ FABRIC_RUN_ID: '1', CONSUMERS: ' llm-llamacpp,vla , llm-llamacpp' })
  assert.equal(run.status, 0, run.log)
  assert.deepEqual(run.consumers, ['llm-llamacpp', 'vla'])
  assert.deepEqual(run.lookups, ['1'])
  assert.match(run.log, /::notice::llm-llamacpp installs the published addon \(nx_prebuild_run_id is empty\)/)
  assert.match(run.summary, /- vla: published addon/)
})

test('resolve: a run id no selected consumer uses is flagged', () => {
  const run = resolveConsumers({ ...ALL_IDS, CONSUMERS: 'llm-llamacpp' })
  assert.equal(run.status, 0, run.log)
  assert.match(run.log, /::warning::classification_prebuild_run_id=3 is set but no selected consumer uses it/)
  assert.match(run.log, /::warning::vla_prebuild_run_id=4 is set but no selected consumer uses it/)
  assert.deepEqual([...run.lookups].sort(), ['1', '2'])
})
