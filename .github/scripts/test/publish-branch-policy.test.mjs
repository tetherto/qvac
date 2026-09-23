// Locks addon publish pipelines to release-* pushes. Nothing else can: these
// workflows never run on a pull request, so a reintroduced feature-*/tmp-*
// filter is invisible until it publishes off someone's PR branch.
//
// Known cost, accepted deliberately: decoder-audio is the only one of the 14
// whose run-integration-tests and mobile-integration-tests hang off
// publish-logic directly rather than post-build-gate, so it is the only addon
// whose post-merge integration and Device Farm legs genuinely ran on a main
// push and now will not. For the other four carrying these legs the gate can
// never fire on merge, so they were already dead there. Restoring them would
// mean a Device Farm run on every main push to decoder-audio, which the
// device-minute programme is spending down; the PR-time lane keeps the
// coverage.
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
const isAllowed = (branch) => ALLOWED.includes(branch) || branch.startsWith('release-')

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
const KNOWN = [
  'on-merge-asr-ggml.yml',
  'on-merge-audiogen-ggml.yml',
  'on-merge-bci-whispercpp.yml',
  'on-merge-classification-ggml.yml',
  'on-merge-decoder-audio.yml',
  'on-merge-diffusion-cpp.yml',
  'on-merge-embed-llamacpp.yml',
  'on-merge-fabric.yml',
  'on-merge-llm-llamacpp.yml',
  'on-merge-model-fit.yml',
  'on-merge-ocr-ggml.yml',
  'on-merge-translation-nmtcpp.yml',
  'on-merge-tts-ggml.yml',
  'on-merge-vla.yml',
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
function onBlock(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => /^on:\s*$/.test(line))
  assert.notEqual(start, -1, 'workflow has no top-level `on:` block')
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    body.push(line)
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
    if (/^ {4}\S/.test(line)) break
    const m = line.match(/^ {6}-\s*(.+?)\s*$/)
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
