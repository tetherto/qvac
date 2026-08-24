'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { validateTestGroups, platformNames } = require('../lib/validate-test-groups.js')
const groups = require('../../test/mobile/test-groups.json')

const integrationAutoPath = path.resolve(__dirname, '../../test/mobile/integration.auto.cjs')

function generatedRunners() {
  const content = fs.readFileSync(integrationAutoPath, 'utf8')
  return Array.from(content.matchAll(/^async function (run[A-Za-z0-9_]+)\s*\(/gm), (m) => m[1])
}

test('the committed test-groups.json covers every generated runner', () => {
  assert.deepEqual(validateTestGroups(groups, generatedRunners()), [])
})

test('deferred runners are declared, not silently absent', () => {
  // pi05 mobile coverage is deferred pending a project-owned CDN mirror, and
  // pi05.test.js is gated on-device by `_skipMobilePi05`. Recording it here is
  // what keeps "not scheduled" distinguishable from "forgotten".
  assert.deepEqual(groups.deferred, ['runPi05Test'])
  for (const platform of platformNames(groups)) {
    const scheduled = Object.values(groups[platform]).flat()
    assert.ok(
      !scheduled.includes('runPi05Test'),
      `runPi05Test must not be scheduled on ${platform}`
    )
  }
})

test('"deferred" is a top-level key, never a platform', () => {
  // The Device Farm composites read only `.<platform>`, so a `deferred` key
  // nested inside ios/android would be scheduled as a real shard.
  assert.ok(!platformNames(groups).includes('deferred'))
  assert.deepEqual(platformNames(groups).sort(), ['android', 'ios'])
})

test('an unassigned runner is reported', () => {
  const problems = validateTestGroups(groups, [...generatedRunners(), 'runBrandNewTest'])
  assert.equal(problems.length, platformNames(groups).length)
  assert.ok(problems.every((p) => p.includes('runBrandNewTest')))
})

test('a typo in a group is reported', () => {
  const typo = {
    ios: { smolvla: ['runAddonTest', 'runTypoTest'] },
    deferred: []
  }
  const problems = validateTestGroups(typo, ['runAddonTest'])
  assert.ok(problems.some((p) => p.includes('runTypoTest') && p.includes('do not exist')))
})

test('a stale deferred entry is reported', () => {
  const stale = {
    ios: { smolvla: ['runAddonTest'] },
    deferred: ['runRemovedTest']
  }
  const problems = validateTestGroups(stale, ['runAddonTest'])
  assert.ok(problems.some((p) => p.includes('runRemovedTest') && p.includes('do not exist')))
})

test('a runner that is both scheduled and deferred is reported', () => {
  const contradictory = {
    ios: { smolvla: ['runAddonTest'] },
    deferred: ['runAddonTest']
  }
  const problems = validateTestGroups(contradictory, ['runAddonTest'])
  assert.ok(problems.some((p) => p.includes('both scheduled and listed')))
})

test('metadata keys that are not platform maps are ignored', () => {
  // OCR ships a top-level `perf_report_filter` string; the shape must tolerate
  // sibling metadata without treating it as a platform.
  const withMetadata = {
    ios: { smolvla: ['runAddonTest'] },
    perf_report_filter: 'something|else',
    deferred: []
  }
  assert.deepEqual(platformNames(withMetadata), ['ios'])
  assert.deepEqual(validateTestGroups(withMetadata, ['runAddonTest']), [])
})
