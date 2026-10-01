// A re-run of a half-shipped train must leave origin's tags alone when they
// point at this commit, and fail when one points elsewhere. These lock that
// decision against fake ls-remote output.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLsRemote, planTags } from '../lib/release-train-tags.mjs'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)

const TARGETS = [
  { slug: 'inference', dir: 'packages/inference', viaRelease: false },
  { slug: 'sdk', dir: 'packages/sdk', viaRelease: true },
  { slug: 'cli', dir: 'packages/cli', viaRelease: false },
]
const VERSIONS = { 'packages/inference': '0.21.0', 'packages/sdk': '0.21.0', 'packages/cli': '0.15.0' }

const ALL_MOVED = new Set(['inference', 'sdk', 'cli'])

function plan (onOrigin, movedSlugs = ALL_MOVED) {
  return planTags(TARGETS, {
    movedSlugs,
    versionOf: (dir) => VERSIONS[dir],
    remoteCommit: (tag) => onOrigin[tag] ?? null,
    head: HEAD,
  })
}

test('reads the commit an annotated tag points at, not the tag object', () => {
  const output = `${TAG_OBJECT}\trefs/tags/cli-v0.15.0\n${HEAD}\trefs/tags/cli-v0.15.0^{}\n`
  assert.equal(parseLsRemote(output, 'cli-v0.15.0'), HEAD)
})

test('reads a lightweight tag, and reports a missing one as null', () => {
  assert.equal(parseLsRemote(`${HEAD}\trefs/tags/cli-v0.15.0\n`, 'cli-v0.15.0'), HEAD)
  assert.equal(parseLsRemote('', 'cli-v0.15.0'), null)
  assert.equal(parseLsRemote(`${HEAD}\trefs/tags/cli-v0.15.00\n`, 'cli-v0.15.0'), null)
})

test('creates the tags origin does not have, and leaves the release tag to its release', () => {
  const result = plan({})
  assert.deepEqual(result.create, ['inference-v0.21.0', 'cli-v0.15.0'])
  assert.deepEqual(result.viaRelease, ['sdk'])
  assert.deepEqual(result.conflicts, [])
})

test('leaves a tag alone when origin already has it at this commit', () => {
  const result = plan({ 'inference-v0.21.0': HEAD })
  assert.deepEqual(result.existing, ['inference-v0.21.0'])
  assert.deepEqual(result.create, ['cli-v0.15.0'])
})

test('reports a tag that origin has at a different commit', () => {
  const result = plan({ 'cli-v0.15.0': OTHER })
  assert.deepEqual(result.conflicts, [{ tag: 'cli-v0.15.0', commit: OTHER }])
})

test('an engine-only train tags the engine and leaves the rest alone', () => {
  // cli stays at 0.14.0, whose tag is on origin at the commit that released
  // it. Reading that as a conflict stopped the run before it tagged inference.
  const result = planTags(TARGETS, {
    movedSlugs: new Set(['inference', 'sdk']),
    versionOf: (dir) => ({ ...VERSIONS, 'packages/cli': '0.14.0' })[dir],
    remoteCommit: (tag) => (tag === 'cli-v0.14.0' ? OTHER : null),
    head: HEAD,
  })

  assert.deepEqual(result.create, ['inference-v0.21.0'])
  assert.deepEqual(result.viaRelease, ['sdk'])
  assert.deepEqual(result.unchanged, ['cli'])
  assert.deepEqual(result.conflicts, [])
})

test('a package the train moved still conflicts on a moved tag', () => {
  const result = plan({ 'inference-v0.21.0': OTHER }, new Set(['inference']))
  assert.deepEqual(result.conflicts, [{ tag: 'inference-v0.21.0', commit: OTHER }])
  assert.deepEqual(result.unchanged, ['sdk', 'cli'])
})
