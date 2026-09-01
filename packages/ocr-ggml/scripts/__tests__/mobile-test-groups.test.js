'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  validateTestGroups,
  generatedRunnerNames,
  platformNames,
  legacyFlatGroups,
  FLAT_LABEL
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
  assert.ok(runners.includes('runOcrBasicTest'))
  assert.ok(runners.every((name) => name.startsWith('run')))
})

test('coverage is required per platform, not pooled across them', () => {
  // The validator this replaced pooled android + ios into a single covered set,
  // so a runner scheduled only on android counted as covered on ios. This is the
  // rule change: the same file that used to validate clean now reports the ios
  // gap. runDoctrWarmTest is scheduled on android only, hence the deferral.
  const pooled = {
    android: { regular: ['runOnlyOnAndroidTest', 'runEverywhereTest'] },
    ios: { regular: ['runEverywhereTest'] }
  }
  const problems = validateTestGroups(pooled, ['runOnlyOnAndroidTest', 'runEverywhereTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith('[ios]'))
  assert.ok(problems[0].includes('runOnlyOnAndroidTest'))
})

test('the android-only runners are declared deferred on ios, not silently absent', () => {
  // android-opencl.test.js and android-vulkan.test.js both guard themselves with
  // `platform !== 'android'`, so scheduling them on ios would burn a Device Farm
  // slot on a clean skip. runDoctrWarmTest is the Mali/Vulkan warm profile added
  // to android's perf group only (#2715). Recording all three here is what keeps
  // "not scheduled on ios" distinguishable from "forgotten on ios".
  assert.deepEqual(groups.deferred, {
    ios: ['runAndroidOpenclTest', 'runAndroidVulkanTest', 'runDoctrWarmTest']
  })

  const iosScheduled = Object.values(groups.ios).flat()
  for (const name of groups.deferred.ios) {
    assert.ok(!iosScheduled.includes(name), `${name} must not be scheduled on ios`)
  }
  // Deferred on ios only — android still schedules all three.
  const androidScheduled = Object.values(groups.android).flat()
  for (const name of groups.deferred.ios) {
    assert.ok(androidScheduled.includes(name), `${name} must still be scheduled on android`)
  }
})

test('"deferred" is a top-level key, never a platform', () => {
  // The Device Farm composites read only `.<platform>`, so a `deferred` key
  // nested inside ios/android would be scheduled as a real shard. Pinning the
  // exact platform names also catches a rename (`iOS`): the composites lowercase
  // the platform before the lookup, so a renamed key would silently resolve to
  // no shards and fall back to single-spec mode.
  assert.deepEqual(platformNames(groups).sort(), ['android', 'ios'])
})

test('a "deferred" key nested inside a platform is reported', () => {
  // The assertion above only covers the committed file's shape. This covers the
  // hazard itself: nested under a platform, `deferred` is just another array of
  // runner names, so every other rule is satisfied and the file would otherwise
  // validate clean — while upload-to-devicefarm schedules it as a real shard.
  const nested = {
    ios: { regular: ['runOcrBasicTest'], deferred: ['runAndroidVulkanTest'] },
    android: { regular: ['runOcrBasicTest'], deferred: ['runAndroidVulkanTest'] }
  }
  const problems = validateTestGroups(nested, ['runOcrBasicTest', 'runAndroidVulkanTest'])

  assert.equal(problems.length, 2, 'exactly one problem per platform')
  for (const platform of ['ios', 'android']) {
    const reported = problems.some(
      (p) => p.startsWith(`[${platform}]`) && p.includes('nested inside the platform map')
    )
    assert.ok(reported, `${platform} must report the nested "deferred" key`)
  }
})

test('deferral can be scoped per platform', () => {
  // What OCR's committed file needs. The flat array form cannot express it,
  // because the scheduled-and-deferred rule fires on the platform that does run
  // it — proven below rather than asserted in prose.
  const perPlatform = {
    ios: { regular: ['runOcrBasicTest'] },
    android: { regular: ['runOcrBasicTest'], gpu: ['runAndroidVulkanTest'] },
    deferred: { ios: ['runAndroidVulkanTest'] }
  }
  assert.deepEqual(validateTestGroups(perPlatform, ['runOcrBasicTest', 'runAndroidVulkanTest']), [])

  const flat = {
    ios: { regular: ['runOcrBasicTest'] },
    android: { regular: ['runOcrBasicTest'], gpu: ['runAndroidVulkanTest'] },
    deferred: ['runAndroidVulkanTest']
  }
  const problems = validateTestGroups(flat, ['runOcrBasicTest', 'runAndroidVulkanTest'])
  assert.ok(problems.some((p) => p.startsWith('[android]') && p.includes('both scheduled')))
})

test('a per-platform "deferred" keyed by a non-platform is reported', () => {
  // `io` defers nothing, so runAndroidVulkanTest is still unassigned on ios —
  // without this rule the typo reads as a clean file.
  const typo = {
    ios: { regular: ['runOcrBasicTest'] },
    deferred: { io: ['runAndroidVulkanTest'] }
  }
  const problems = validateTestGroups(typo, ['runOcrBasicTest', 'runAndroidVulkanTest'])
  assert.ok(problems.some((p) => p.includes('not platforms') && p.includes('io')))
  assert.ok(problems.some((p) => p.startsWith('[ios]') && p.includes('runAndroidVulkanTest')))
})

test('an explicit platform list overrides shape inference', () => {
  // llm-llamacpp ships top-level `iosWeekly`/`androidWeekly` maps that are
  // schedules, not platforms; inferring from shape would demand full coverage of
  // them too. A caller there pins the platform list instead. OCR's CLI infers,
  // because inference is what keeps the legacy flat shape below working.
  const withSchedules = {
    ios: { regular: ['runOcrBasicTest'] },
    android: { regular: ['runOcrBasicTest'] },
    iosWeekly: { nightly: ['runOcrBasicTest'] },
    androidWeekly: { nightly: ['runOcrBasicTest'] }
  }
  const inferred = validateTestGroups(withSchedules, ['runOcrBasicTest', 'runLargeImagesTest'])
  assert.equal(inferred.length, 4, 'inference treats the weekly maps as platforms')

  const pinned = validateTestGroups(withSchedules, ['runOcrBasicTest', 'runLargeImagesTest'], {
    platforms: ['ios', 'android']
  })
  assert.equal(pinned.length, 2)
  assert.ok(pinned.every((p) => p.startsWith('[ios]') || p.startsWith('[android]')))
})

test('a pinned platform missing from the file is reported', () => {
  const problems = validateTestGroups(
    { ios: { regular: ['runOcrBasicTest'] } },
    ['runOcrBasicTest'],
    {
      platforms: ['ios', 'android']
    }
  )
  assert.ok(problems.some((p) => p.startsWith('[android]') && p.includes('no `{')))
})

test('an unassigned runner is reported on every platform', () => {
  const problems = validateTestGroups(groups, [...committedRunners(), 'runBrandNewTest'])
  assert.equal(problems.length, platformNames(groups).length)
  assert.ok(problems.every((p) => p.includes('runBrandNewTest')))
})

test('a typo in a group is reported', () => {
  const typo = {
    ios: { regular: ['runOcrBasicTest', 'runTypoTest'] },
    deferred: []
  }
  const problems = validateTestGroups(typo, ['runOcrBasicTest'])
  assert.ok(problems.some((p) => p.includes('runTypoTest') && p.includes('do not exist')))
})

test('a stale deferred entry is reported', () => {
  const stale = {
    ios: { regular: ['runOcrBasicTest'] },
    deferred: ['runRemovedTest']
  }
  const problems = validateTestGroups(stale, ['runOcrBasicTest'])
  assert.ok(problems.some((p) => p.includes('runRemovedTest') && p.includes('do not exist')))
})

test('a stale entry in a per-platform deferred is reported', () => {
  const stale = {
    ios: { regular: ['runOcrBasicTest'] },
    deferred: { ios: ['runRemovedTest'] }
  }
  const problems = validateTestGroups(stale, ['runOcrBasicTest'])
  assert.ok(problems.some((p) => p.includes('runRemovedTest') && p.includes('do not exist')))
})

test('a runner that is both scheduled and deferred is reported', () => {
  const contradictory = {
    ios: { regular: ['runOcrBasicTest'] },
    deferred: ['runOcrBasicTest']
  }
  const problems = validateTestGroups(contradictory, ['runOcrBasicTest'])
  assert.ok(problems.some((p) => p.includes('both scheduled and listed')))
})

test('the top-level perf_report_filter stays ignored metadata', () => {
  // OCR ships a top-level `perf_report_filter` string, read on device by
  // test/integration/utils.js. It is neither a platform nor a group; the shape
  // must tolerate it without demanding coverage of it or reporting it.
  assert.equal(typeof groups.perf_report_filter, 'string')
  assert.deepEqual(platformNames(groups).sort(), ['android', 'ios'])

  const withMetadata = {
    ios: { regular: ['runOcrBasicTest'] },
    perf_report_filter: 'clinical_chemistry|ct_scan_report',
    deferred: []
  }
  assert.deepEqual(platformNames(withMetadata), ['ios'])
  assert.deepEqual(validateTestGroups(withMetadata, ['runOcrBasicTest']), [])
})

test('the legacy flat groupName-to-array shape still validates', () => {
  // OCR commits the nested android/ios shape, but the validator this replaced
  // accepted a flat file too, so an old-format file must not become a hard
  // failure. Flat has no platform split: its one group map is a coverage claim
  // about every platform at once.
  const flat = {
    perf: ['runDoctrClinicalChemistryTest'],
    regularA: ['runOcrBasicTest'],
    perf_report_filter: 'clinical_chemistry'
  }
  assert.deepEqual(platformNames(flat), [], 'a flat file declares no platforms')
  assert.deepEqual(Object.keys(legacyFlatGroups(flat)).sort(), ['perf', 'regularA'])
  assert.deepEqual(
    validateTestGroups(flat, ['runDoctrClinicalChemistryTest', 'runOcrBasicTest']),
    []
  )
})

test('the legacy flat shape still reports an unassigned runner', () => {
  const flat = { regularA: ['runOcrBasicTest'] }
  const problems = validateTestGroups(flat, ['runOcrBasicTest', 'runBrandNewTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith(`[${FLAT_LABEL}]`))
  assert.ok(problems[0].includes('runBrandNewTest'))
})

test('the legacy flat shape honours a top-level deferred list', () => {
  const flat = { regularA: ['runOcrBasicTest'], deferred: ['runAndroidVulkanTest'] }
  assert.deepEqual(legacyFlatGroups(flat), { regularA: ['runOcrBasicTest'] })
  assert.deepEqual(validateTestGroups(flat, ['runOcrBasicTest', 'runAndroidVulkanTest']), [])
})

test('a file with neither shape is reported rather than passing vacuously', () => {
  const problems = validateTestGroups({ perf_report_filter: 'clinical_chemistry' }, [
    'runOcrBasicTest'
  ])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('declares no test groups'))
})
