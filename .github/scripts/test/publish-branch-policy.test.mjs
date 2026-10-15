// Locks addon publish pipelines to release-* pushes. Nothing else can: these
// workflows never run on a pull request, so a reintroduced feature-*/tmp-*
// filter is invisible until it publishes off someone's PR branch.
//
// Intended, not merely accepted: FOUR addons lose post-merge integration and
// Device Farm legs on main, not one. Post-merge phone runs are not part of how
// mobile is tested here — the on-demand dispatch lane is — so a Device Farm run
// firing on every merge is spend with no reader, which the device-minute
// programme exists to remove. decoder-audio, asr-ggml, bci-whispercpp and
// tts-ggml set postIntegrationOnGpr in project.json, so post-build-gate
// hands them desktop and mobile integration tests after a GPR publish too.
//
// Restoring them would mean a Device Farm run per main push across four
// addons. The PR-time lane keeps the coverage.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')

// Keyed on behaviour, not filename, so a renamed pipeline stays covered.
// Anchored to `uses:` so a workflow that merely names the action in a log or
// remediation string is not mistaken for a publish pipeline.
const PUBLISH_MARKER = /uses:.*(npm-publish-logic|publish-library-to-(gpr|npm))/

const ALLOWED = ['release-*']

// A pattern is allowed when every branch it can match is a release branch. That
// is `release-*` itself and any narrower glob under it, e.g. publish-inference's
// `release-inference-*` — per docs/gitflow.md you PR INTO a release branch from
// a fork, so a push to one is a merge, which is the publish trigger this policy
// exists to permit. Comparing the glob literally rejected the narrower spelling
// and would reject every future `release-<pkg>-*` pipeline the same way.
// A `!` pattern only removes branches an earlier pattern matched, so it can
// never add a trigger; `!release-train-*` hands those branches to
// release-train.yml.
const isAllowed = (branch) =>
  ALLOWED.includes(branch) || branch.startsWith('release-') || branch.startsWith('!')

// Same markers, different family: single-job npm publishes with no prebuild
// matrix. Listed so they are explicitly exempt rather than silently failing.
// Enumerated, not globbed. A `readdirSync(...).startsWith('trigger-reusable-')`
// spread exempted any FUTURE file on that prefix with no test edit and no review
// signal, on a name this repo already blesses for publish workflows — and
// publishWorkflows() subtracts this set before testing the marker, so exemption
// beat detection. A dropped-in trigger-reusable-*.yml carrying both publish
// markers and pushing off main/feature-*/tmp-* passed every assertion.
const LIBRARY_PUBLISHERS = new Set([
  'publish-registry-server.yml',
  'publish-sdk.yml',
  'trigger-reusable-infer-base.yml',
  'trigger-reusable-lib-ai-sdk-provider.yml',
  'trigger-reusable-lib-cli.yml',
  'trigger-reusable-lib-error.yml',
  'trigger-reusable-lib-logging.yml',
  'trigger-reusable-lib-openclaw-plugin.yml',
  'trigger-reusable-lib-opencode-plugin.yml',
  'trigger-reusable-lib-rag.yml',
  'trigger-reusable-lib-test-suite.yml',
  'trigger-reusable-lib.yml',
])

// Guards against discovery returning an empty set and passing vacuously.
// Native addons, including model-fit, publish through on-merge-nx.
// Add a pipeline here when one appears.
const KNOWN = [
  'on-merge-ggml-rpc-server.yml',
  'on-merge-nx.yml',
]

function read(name) {
  return readFileSync(join(WORKFLOW_DIR, name), 'utf8')
}

function publishWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => !LIBRARY_PUBLISHERS.has(name))
    .filter((name) => PUBLISH_MARKER.test(read(name)))
    .sort()
}

// Indentation-scoped, not YAML-parsed: this suite runs with no deps installed.
// Comments and blank lines are dropped and any indent width is re-indented to
// two spaces per level, so the fixed-offset readers below see one shape.
function onBlock(source) {
  const lines = source.split('\n').filter((line) => line.trim() && !/^\s*#/.test(line))
  const start = lines.findIndex((line) => /^on:\s*(#.*)?$/.test(line))
  assert.notEqual(start, -1, 'workflow has no top-level `on:` block')
  const body = []
  const stack = [0]
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const indent = line.length - line.trimStart().length
    while (indent < stack.at(-1)) stack.pop()
    if (indent > stack.at(-1)) stack.push(indent)
    body.push(' '.repeat(2 * (stack.length - 1)) + line.trimStart())
  }
  return body
}

// null = no push trigger at all. 'unreadable' = there IS one, written in a shape
// this parser cannot read (YAML flow mapping, e.g. `push: {branches: [main]}`),
// which GitHub accepts. Treating that as "no push trigger" skipped the check
// entirely, so the one shape the suite could not read was a shape that silently
// re-permits main/feature-*/tmp-* publishes — the regression this file exists to
// catch. It is routed into the fail-closed 'all' path instead.
function pushBody(source) {
  const block = onBlock(source)
  const idx = block.findIndex((line) => /^ {2}push:/.test(line))
  if (idx === -1) return null
  // A trailing `#` comment still leaves it a block key; anything else is a value.
  const rest = block[idx].replace(/^ {2}push:/, '').trim()
  if (rest !== '' && !rest.startsWith('#')) return 'unreadable'
  const body = []
  for (const line of block.slice(idx + 1)) {
    if (/^ {2}\S/.test(line)) break
    body.push(line)
  }
  return body
}

// 'none' = no push trigger; 'all' = no branch filter or branches-ignore;
// 'list' = an explicit allow-list. 'all' is reported rather than skipped: an
// absent filter is the most permissive state there is.
function pushBranches(source) {
  const body = pushBody(source)
  if (body === null) return { kind: 'none' }
  if (body === 'unreadable') return { kind: 'all' }
  if (body.some((line) => /^ {4}branches-ignore:/.test(line))) return { kind: 'all' }

  const flow = body.find((line) => /^ {4}branches:\s*\[/.test(line))
  if (flow) {
    const inner = flow.slice(flow.indexOf('[') + 1, flow.lastIndexOf(']'))
    const branches = inner
      .split(',')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    return branches.length ? { kind: 'list', branches } : { kind: 'all' }
  }

  const idx = body.findIndex((line) => /^ {4}branches:\s*$/.test(line))
  if (idx === -1) return { kind: 'all' }
  const branches = []
  for (const line of body.slice(idx + 1)) {
    // A list may sit at its key's own indent (`branches:` then `- main`).
    if (/^ {0,4}[^\s-]/.test(line)) break
    const m = line.match(/^ {4,6}-\s*(.+?)\s*(#.*)?$/)
    if (m) branches.push(m[1].replace(/^["']|["']$/g, ''))
  }
  return branches.length ? { kind: 'list', branches } : { kind: 'all' }
}

function hasTrigger(source, name) {
  return onBlock(source).some((line) => new RegExp(`^ {2}${name}:`).test(line))
}

test('discovery finds every known addon publish pipeline', () => {
  const found = publishWorkflows()
  for (const name of KNOWN) {
    assert.ok(
      found.includes(name),
      `${name} is no longer detected as a publish pipeline; fix the discovery, ` +
        'do not drop the file from KNOWN',
    )
  }
  assert.ok(found.length >= KNOWN.length)
})

test('every exemption names a file that exists', () => {
  for (const name of LIBRARY_PUBLISHERS) {
    assert.ok(
      existsSync(join(WORKFLOW_DIR, name)),
      `${name} is exempted but no longer exists; drop it from LIBRARY_PUBLISHERS ` +
        'rather than leaving a stale name that would silently exempt a future file ' +
        'reusing it',
    )
  }
})

test('model-fit publishing is covered by the consolidated workflow', () => {
  const source = read('on-merge-nx.yml')
  assert.match(pushBody(source).join('\n'), /^ {6}- "packages\/model-fit\/\*\*"$/m)
  assert.match(source, /^ {10}- model-fit$/m)
  assert.match(source, /^ {12}model-fit: packages\/model-fit\/\*\*$/m)
  assert.equal(existsSync(join(WORKFLOW_DIR, 'on-merge-model-fit.yml')), false)
})

test('no unenumerated workflow is exempt by name pattern', () => {
  const onDisk = readdirSync(WORKFLOW_DIR).filter((n) => n.startsWith('trigger-reusable-'))
  const missing = onDisk.filter((n) => !LIBRARY_PUBLISHERS.has(n))
  assert.deepEqual(
    missing,
    [],
    `${missing.join(', ')} matches the trigger-reusable-* family but is not in ` +
      'LIBRARY_PUBLISHERS. Add it deliberately if it really is a single-job ' +
      'library publish with no prebuild matrix — that is a review decision, ' +
      'which is why the set is enumerated instead of globbed.',
  )
})

test('automatic pushes stay off PR-head branches', () => {
  for (const name of publishWorkflows()) {
    const result = pushBranches(read(name))
    if (result.kind === 'none') continue

    assert.notEqual(
      result.kind,
      'all',
      `${name} has a push trigger with no usable branch allow-list (missing ` +
        '`branches:`, an empty list, `branches-ignore:`, or a `push:` written ' +
        'as a YAML flow mapping). That publishes ' +
        `off every branch. List the branches explicitly: ${ALLOWED.join(', ')}.`,
    )

    const disallowed = result.branches.filter((b) => !isAllowed(b))
    assert.deepEqual(
      disallowed,
      [],
      `${name} push-triggers a publish on ${disallowed.join(', ')}. Those can ` +
        'be an open PR\'s head, so a push to the PR starts the prebuild matrix ' +
        'and a GPR publish. Only ' + ALLOWED.join(' and ') + ' may push-trigger ' +
        'a publish; use workflow_dispatch on the branch instead.',
    )
  }
})

test('the push parser reads comments and any indent width', () => {
  const push = (src) => pushBranches(src)
  const main = { kind: 'list', branches: ['main'] }
  assert.deepEqual(push('on:\n# publish\n  push:\n    branches:\n      - main\n'), main, 'comment at column 0')
  assert.deepEqual(push('on:\n    push:\n        branches:\n            - main\n'), main, 'four-space indent')
  assert.deepEqual(push('on:\n  push:\n    branches:\n    - main\n'), main, 'list at key indent')
  assert.deepEqual(
    push('on:\n  push:\n    branches:\n      - release-*\n    # legacy\n      - main # old\n'),
    { kind: 'list', branches: ['release-*', 'main'] },
    'comment inside the list',
  )
  assert.deepEqual(push('on: # triggers\n  push:\n    branches:\n      - main\n'), main, 'comment on on:')
  assert.deepEqual(
    push('on:\n  push:\n    branches:\n      - release-*\n      - "!release-train-*"\n'),
    { kind: 'list', branches: ['release-*', '!release-train-*'] },
    'quoted negation',
  )
})

test('a negation is allowed, a positive non-release pattern is not', () => {
  assert.ok(isAllowed('!release-train-*'))
  assert.ok(!isAllowed('main'))
  assert.ok(!isAllowed('feature-*'))
})

test('the manual entry point survives', () => {
  for (const name of publishWorkflows()) {
    const source = read(name)
    // A pure reusable is a callee; its caller owns the dispatch.
    if (pushBranches(source).kind === 'none' && hasTrigger(source, 'workflow_call')) continue
    assert.ok(
      hasTrigger(source, 'workflow_dispatch'),
      `${name} has no workflow_dispatch. It is the only remaining way to ` +
        'publish a build from a tmp-*/feature-* branch.',
    )
  }
})
