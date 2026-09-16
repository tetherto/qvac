// Keeps the addon publish pipelines off branches that can be an open PR's head.
// Nothing else can: these workflows never run on a pull request, so a
// reintroduced `feature-*` or `tmp-*` push filter is invisible until it
// publishes off someone's PR branch -- which is how it went unnoticed from
// March to September 2026.
//
// `main` and `release-*` stay allowed. A merge to `main` is the only thing that
// still builds addon prebuilds across all 9 platforms on merged content: the PR
// lanes gate prebuilds behind the ci-router labels, so an unlabeled PR builds
// nothing. Dropping `main` here would let a broken iOS or win32 build merge
// green and stay hidden until a release push.
//
// Branch builds from a `tmp-*`/`feature-*` branch remain available through
// workflow_dispatch, which npm-publish-logic handles on the same code path as
// push.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')

// Publishing is identified by what the workflow does, not by its name, so a
// renamed or newly added publish pipeline is still covered.
const PUBLISH_MARKER = /npm-publish-logic|publish-library-to-(gpr|npm)/

// The only branches a publish pipeline may push-trigger on. Neither can be an
// open PR's head in this repo: PRs target them, they are not pushed from one.
const ALLOWED = ['main', 'release-*']

// The JS library and SDK publishers share the publish markers but are a
// different family: single-job npm publishes with no prebuild matrix, and a
// separate cost case. QVAC-23047 scopes to the addon pipelines, so these are
// exempt here rather than silently in scope and failing.
const LIBRARY_PUBLISHERS = new Set([
  'publish-registry-server.yml',
  'publish-sdk.yml',
  ...readdirSync(WORKFLOW_DIR).filter((n) => n.startsWith('trigger-reusable-')),
])

// Every addon publish pipeline that exists today. Listed so the discovery below
// cannot quietly return an empty set and pass vacuously after a rename.
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

// Returns the body of the top-level `on:` block. Indentation-scoped rather than
// YAML-parsed: these tests run with no dependencies installed.
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

function pushBody(source) {
  const block = onBlock(source)
  const idx = block.findIndex((line) => /^ {2}push:\s*$/.test(line))
  if (idx === -1) return null
  const body = []
  for (const line of block.slice(idx + 1)) {
    if (/^ {2}\S/.test(line)) break
    body.push(line)
  }
  return body
}

// Describes on.push.branches as one of:
//   {kind:'none'}     no push trigger at all -- stricter than the policy
//   {kind:'all'}      push with no branch filter, or a branches-ignore filter
//   {kind:'list', branches:[...]}
// 'all' is reported rather than skipped: an unparsed or absent filter is the
// most permissive state there is, and silently allowing it is exactly how a
// regression would slip past this suite.
function pushBranches(source) {
  const body = pushBody(source)
  if (body === null) return { kind: 'none' }
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

test('automatic pushes stay off PR-head branches', () => {
  for (const name of publishWorkflows()) {
    const result = pushBranches(read(name))
    if (result.kind === 'none') continue

    assert.notEqual(
      result.kind,
      'all',
      `${name} has a push trigger with no usable branch allow-list (missing ` +
        '`branches:`, an empty list, or `branches-ignore:`). That publishes ' +
        `off every branch. List the branches explicitly: ${ALLOWED.join(', ')}.`,
    )

    const disallowed = result.branches.filter((b) => !ALLOWED.includes(b))
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
    // A pure reusable (workflow_call, no triggers of its own) is a callee, not
    // an entry point; its caller owns the dispatch.
    if (pushBranches(source).kind === 'none' && hasTrigger(source, 'workflow_call')) continue
    assert.ok(
      hasTrigger(source, 'workflow_dispatch'),
      `${name} has no workflow_dispatch. It is the only remaining way to ` +
        'publish a build from a tmp-*/feature-* branch.',
    )
  }
})
