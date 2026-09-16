// Locks the addon publish pipelines to release lines. Nothing else can: these
// workflows never run on a pull request, so a reintroduced `main`, `feature-*`
// or `tmp-*` push filter is invisible until it publishes off someone's PR
// branch -- which is how it went unnoticed from March to September 2026.
//
// A push to a matching branch starts the full prebuild matrix (9 platforms) and
// a GPR publish. Restricting the trigger does not remove that capability:
// npm-publish-logic branches on GITHUB_REF_NAME and treats `push` and
// `workflow_dispatch` identically, so dispatching on the same branch yields the
// same dist-tag and the same version string.
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

// The vcpkg cache warmers share the on-merge-* prefix but publish nothing; they
// are main-only by design and must not be dragged into this policy.
const CANDIDATE = /^on-merge-(?!vcpkg-cache-).*\.ya?ml$/

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
    .filter((name) => CANDIDATE.test(name))
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

// The list under `on.push.branches`, comments and blanks dropped.
function pushBranches(source) {
  const block = onBlock(source)
  const pushIdx = block.findIndex((line) => /^ {2}push:\s*$/.test(line))
  if (pushIdx === -1) return null
  const pushBody = []
  for (const line of block.slice(pushIdx + 1)) {
    if (/^ {2}\S/.test(line)) break
    pushBody.push(line)
  }
  const brIdx = pushBody.findIndex((line) => /^ {4}branches:\s*$/.test(line))
  if (brIdx === -1) return null
  const branches = []
  for (const line of pushBody.slice(brIdx + 1)) {
    if (/^ {4}\S/.test(line)) break
    const m = line.match(/^ {6}-\s*(.+?)\s*$/)
    if (m) branches.push(m[1].replace(/^["']|["']$/g, ''))
  }
  return branches
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

test('automatic pushes are restricted to release lines', () => {
  for (const name of publishWorkflows()) {
    const branches = pushBranches(read(name))
    if (branches === null) continue // dispatch-only is stricter, and allowed
    assert.deepEqual(
      branches,
      ['release-*'],
      `${name} publishes automatically on ${branches.join(', ')}. Only ` +
        'release-* may push-trigger a publish pipeline: any other branch ' +
        'publishes off open PR branches. Use workflow_dispatch on the branch ' +
        'instead -- it produces an identical build.',
    )
  }
})

test('the manual entry point survives', () => {
  for (const name of publishWorkflows()) {
    assert.ok(
      hasTrigger(read(name), 'workflow_dispatch'),
      `${name} has no workflow_dispatch. It is the only remaining way to ` +
        'publish a branch build now that non-release pushes are off.',
    )
  }
})
