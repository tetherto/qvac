'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  validateTestGroups,
  generatedRunnerNames,
  platformNames
} = require('../lib/validate-test-groups.js')
const groups = require('../../test/mobile/test-groups.json')

const integrationAutoPath = path.resolve(__dirname, '../../test/mobile/integration.auto.cjs')

// The extractor under test, not a copy of it: validate-mobile-tests.js calls the
// same `generatedRunnerNames`, so a change to the pattern is caught here.
function committedRunners() {
  return generatedRunnerNames(fs.readFileSync(integrationAutoPath, 'utf8'))
}

test('the committed test-groups.json covers every generated runner', () => {
  assert.deepEqual(validateTestGroups(groups, committedRunners()), [])
})

test('the runner extractor reads the committed integration.auto.cjs', () => {
  // Pins the shared extractor against real generated output, so a template
  // change that renames the declarations cannot silently yield zero runners —
  // which would make every coverage rule below vacuously pass.
  const runners = committedRunners()
  assert.ok(runners.length > 0, 'integration.auto.cjs must declare at least one runner')
  assert.ok(runners.includes('runPi05Test'))
  assert.ok(runners.every((name) => name.startsWith('run')))
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

test('an object-form "deferred" is still not a platform', () => {
  // Inference excludes `deferred` by name, not by shape, so the per-platform map
  // form below cannot be mistaken for a platform needing full coverage.
  const perPlatform = {
    ios: { smolvla: ['runAddonTest'] },
    android: { smolvla: ['runAddonTest'] },
    deferred: { ios: ['runPi05Test'] }
  }
  assert.deepEqual(platformNames(perPlatform).sort(), ['android', 'ios'])
})

test('a "deferred" key nested inside a platform is reported', () => {
  // The assertion above only covers the committed file's shape. This covers the
  // hazard itself: nested under a platform, `deferred` is just another array of
  // runner names, so every other rule is satisfied and the file would otherwise
  // validate clean — while upload-to-devicefarm schedules it as a real shard.
  const nested = {
    ios: { smolvla: ['runAddonTest'], deferred: ['runPi05Test'] },
    android: { smolvla: ['runAddonTest'], deferred: ['runPi05Test'] }
  }
  const problems = validateTestGroups(nested, ['runAddonTest', 'runPi05Test'])

  assert.equal(problems.length, 2, 'exactly one problem per platform')
  for (const platform of ['ios', 'android']) {
    const reported = problems.some(
      (p) => p.startsWith(`[${platform}]`) && p.includes('nested inside the platform map')
    )
    assert.ok(reported, `${platform} must report the nested "deferred" key`)
  }
})

test('deferral can be scoped per platform', () => {
  // Deferring on one platform while scheduling on another is what llm-llamacpp
  // and ocr-ggml need; the flat array form cannot express it, because the
  // scheduled-and-deferred rule would fire on the platform that does run it.
  const perPlatform = {
    ios: { smolvla: ['runAddonTest'] },
    android: { smolvla: ['runAddonTest'], heavy: ['runBigTest'] },
    deferred: { ios: ['runBigTest'] }
  }
  assert.deepEqual(validateTestGroups(perPlatform, ['runAddonTest', 'runBigTest']), [])

  const flat = {
    ios: { smolvla: ['runAddonTest'] },
    android: { smolvla: ['runAddonTest'], heavy: ['runBigTest'] },
    deferred: ['runBigTest']
  }
  const problems = validateTestGroups(flat, ['runAddonTest', 'runBigTest'])
  assert.ok(problems.some((p) => p.startsWith('[android]') && p.includes('both scheduled')))
})

test('a per-platform "deferred" keyed by a non-platform is reported', () => {
  // `io` defers nothing, so runBigTest is still unassigned on ios — without this
  // rule the typo reads as a clean file.
  const typo = {
    ios: { smolvla: ['runAddonTest'] },
    deferred: { io: ['runBigTest'] }
  }
  const problems = validateTestGroups(typo, ['runAddonTest', 'runBigTest'])
  assert.ok(problems.some((p) => p.includes('not platforms') && p.includes('io')))
  assert.ok(problems.some((p) => p.startsWith('[ios]') && p.includes('runBigTest')))
})

test('an explicit platform list overrides shape inference', () => {
  // llm-llamacpp ships top-level `iosWeekly`/`androidWeekly` maps that are
  // schedules, not platforms; inferring from shape would demand full coverage of
  // them too. Callers there pin the platform list instead.
  const withSchedules = {
    ios: { smolvla: ['runAddonTest'] },
    android: { smolvla: ['runAddonTest'] },
    iosWeekly: { nightly: ['runAddonTest'] },
    androidWeekly: { nightly: ['runAddonTest'] }
  }
  const inferred = validateTestGroups(withSchedules, ['runAddonTest', 'runBigTest'])
  assert.equal(inferred.length, 4, 'inference treats the weekly maps as platforms')

  const pinned = validateTestGroups(withSchedules, ['runAddonTest', 'runBigTest'], {
    platforms: ['ios', 'android']
  })
  assert.equal(pinned.length, 2)
  assert.ok(pinned.every((p) => p.startsWith('[ios]') || p.startsWith('[android]')))
})

test('a pinned platform missing from the file is reported', () => {
  const problems = validateTestGroups({ ios: { smolvla: ['runAddonTest'] } }, ['runAddonTest'], {
    platforms: ['ios', 'android']
  })
  assert.ok(problems.some((p) => p.startsWith('[android]') && p.includes('no `{')))
})

test('an unassigned runner is reported', () => {
  const problems = validateTestGroups(groups, [...committedRunners(), 'runBrandNewTest'])
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

test('a stale entry in a per-platform deferred is reported', () => {
  const stale = {
    ios: { smolvla: ['runAddonTest'] },
    deferred: { ios: ['runRemovedTest'] }
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
