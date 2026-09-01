'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  validateTestGroups,
  generatedRunnerNames,
  platformFamily,
  platformNames,
  isOverrideOnly
} = require('../lib/validate-test-groups.js')
const groups = require('../../test/mobile/test-groups.json')

const integrationAutoPath = path.resolve(__dirname, '../../test/mobile/integration.auto.cjs')

// The families validate-mobile-tests.js pins. Kept in one place here so the
// assertions below describe the same requirement the script enforces.
const PLATFORMS = ['ios', 'android']

// The extractor under test, not a copy of it: validate-mobile-tests.js calls the
// same `generatedRunnerNames`, so a change to the pattern is caught here.
function committedRunners() {
  return generatedRunnerNames(fs.readFileSync(integrationAutoPath, 'utf8'))
}

test('the committed test-groups.json covers every generated runner', () => {
  assert.deepEqual(validateTestGroups(groups, committedRunners(), { platforms: PLATFORMS }), [])
})

test('the runner extractor reads the committed integration.auto.cjs', () => {
  // Pins the shared extractor against real generated output, so a template
  // change that renames the declarations cannot silently yield zero runners —
  // which would make every coverage rule below vacuously pass.
  const runners = committedRunners()
  assert.ok(runners.length > 0, 'integration.auto.cjs must declare at least one runner')
  assert.ok(runners.includes('runApiBehaviorTest'))
  assert.ok(runners.every((name) => name.startsWith('run')))
})

test('the committed file schedules the weekly suites as a disjoint subset', () => {
  // The premise of family pooling: the weekly maps are not a duplicate of the
  // daily ones. If they ever became a subset of them, pooling would be dead
  // weight and this suite would stop proving anything about it.
  const daily = new Set(Object.values(groups.ios).flat())
  const weekly = Object.values(groups.iosWeekly).flat()
  assert.ok(
    weekly.some((name) => !daily.has(name)),
    'iosWeekly must schedule at least one runner that ios does not'
  )
})

test('coverage is pooled across a family, not demanded of each map', () => {
  // Without pooling, `iosWeekly` would owe full coverage of every runner — the
  // exact failure mode the vla-ggml lib's shape inference would produce here.
  const pooled = {
    ios: { light: ['runDailyTest'] },
    iosWeekly: { heavy: ['runWeeklyTest'] },
    android: { light: ['runDailyTest'], heavy: ['runWeeklyTest'] }
  }
  const runners = ['runDailyTest', 'runWeeklyTest']
  assert.deepEqual(validateTestGroups(pooled, runners, { platforms: PLATFORMS }), [])

  // Inference agrees, because it folds `iosWeekly` into `ios` rather than
  // returning it as a platform of its own.
  assert.deepEqual(platformNames(pooled).sort(), ['android', 'ios'])
  assert.deepEqual(validateTestGroups(pooled, runners), [])
})

test('a runner missing from the whole family is reported once per family', () => {
  const problems = validateTestGroups(groups, [...committedRunners(), 'runBrandNewTest'], {
    platforms: PLATFORMS
  })
  assert.equal(problems.length, PLATFORMS.length)
  assert.ok(problems.every((p) => p.includes('runBrandNewTest')))
  assert.ok(problems.some((p) => p.includes('Add them to a ios or iosWeekly group')))
})

test('benchmark shards stay exempt from the coverage requirement', () => {
  // The Benchmark Performance workflow schedules runBenchmarkPerf* through an
  // explicit test_groups override, and finetuning-moe.test.js is likewise driven
  // by its own workflow, so both are deliberately absent from test-groups.json;
  // requiring them here would make the committed file red.
  assert.ok(isOverrideOnly('runBenchmarkPerf2bQ40F16Test'))
  assert.ok(isOverrideOnly('runFinetuningMoeTest'))
  assert.ok(!isOverrideOnly('runBenchmarkSomethingElseTest'))

  // A newly generated shard is exempt; an ordinary new test in the same run is
  // not — so the exemption cannot be masking a real gap.
  const withNewShard = validateTestGroups(
    groups,
    [...committedRunners(), 'runBenchmarkPerf4bQ80F16Test'],
    { platforms: PLATFORMS }
  )
  assert.deepEqual(withNewShard, [])

  const withNewTest = validateTestGroups(groups, [...committedRunners(), 'runBrandNewTest'], {
    platforms: PLATFORMS
  })
  assert.equal(withNewTest.length, PLATFORMS.length)
})

test('an override-only runner named by a group must still exist', () => {
  // Exempt from coverage is not exempt from correctness: the override workflows
  // grep integration.auto.cjs for these names.
  const typo = {
    ios: { bench: ['runBenchmarkPerfGoneTest'] },
    android: { bench: ['runBenchmarkPerfGoneTest'] }
  }
  const problems = validateTestGroups(typo, [], { platforms: PLATFORMS })
  assert.equal(problems.length, 2)
  assert.ok(problems.every((p) => p.includes('runBenchmarkPerfGoneTest')))
  assert.ok(problems.every((p) => p.includes('do not exist')))
})

test('the family of a platform drops only a trailing Weekly', () => {
  assert.equal(platformFamily('iosWeekly'), 'ios')
  assert.equal(platformFamily('android'), 'android')
  assert.equal(platformFamily('weeklyIos'), 'weeklyIos')
})

test('a pinned platform missing from the file is reported', () => {
  const problems = validateTestGroups({ ios: { light: ['runAddonTest'] } }, ['runAddonTest'], {
    platforms: PLATFORMS
  })
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith('[android]'))
  assert.ok(problems[0].includes('no `{'))
})

test('a group map belonging to no required platform is named', () => {
  // Pooling by family is what makes this dangerous: `iosWekly` folds into a
  // family nobody requires, so its runners quietly stop counting and `ios` is
  // blamed for not covering them. Both problems are reported.
  const typo = {
    ios: { light: ['runDailyTest'] },
    iosWekly: { heavy: ['runWeeklyTest'] },
    android: { light: ['runDailyTest'], heavy: ['runWeeklyTest'] }
  }
  const problems = validateTestGroups(typo, ['runDailyTest', 'runWeeklyTest'], {
    platforms: PLATFORMS
  })
  assert.ok(problems.some((p) => p.includes('no required platform') && p.includes('iosWekly')))
  assert.ok(problems.some((p) => p.startsWith('[ios]') && p.includes('runWeeklyTest')))
})

test('a typo in a group is reported', () => {
  const typo = {
    ios: { light: ['runAddonTest', 'runTypoTest'] },
    android: { light: ['runAddonTest'] }
  }
  const problems = validateTestGroups(typo, ['runAddonTest'], { platforms: PLATFORMS })
  assert.ok(problems.some((p) => p.includes('runTypoTest') && p.includes('do not exist')))
})

test('deferral excuses a runner from coverage', () => {
  // The escape hatch the hardcoded `isOverrideOnly` allowlist cannot express:
  // an ordinary test that is knowingly not scheduled on device.
  const deferred = {
    ios: { light: ['runAddonTest'] },
    android: { light: ['runAddonTest'] },
    deferred: ['runBigTest']
  }
  assert.deepEqual(
    validateTestGroups(deferred, ['runAddonTest', 'runBigTest'], { platforms: PLATFORMS }),
    []
  )
})

test('deferral can be scoped per family', () => {
  const perFamily = {
    ios: { light: ['runAddonTest'] },
    android: { light: ['runAddonTest'], heavy: ['runBigTest'] },
    deferred: { ios: ['runBigTest'] }
  }
  assert.deepEqual(
    validateTestGroups(perFamily, ['runAddonTest', 'runBigTest'], { platforms: PLATFORMS }),
    []
  )

  const flat = {
    ios: { light: ['runAddonTest'] },
    android: { light: ['runAddonTest'], heavy: ['runBigTest'] },
    deferred: ['runBigTest']
  }
  const problems = validateTestGroups(flat, ['runAddonTest', 'runBigTest'], {
    platforms: PLATFORMS
  })
  assert.ok(problems.some((p) => p.startsWith('[android]') && p.includes('both scheduled')))
})

test('a per-family "deferred" keyed by a non-platform is reported', () => {
  // `io` defers nothing, so runBigTest is still unassigned on ios — without this
  // rule the typo reads as a clean file.
  const typo = {
    ios: { light: ['runAddonTest'] },
    android: { light: ['runAddonTest'], heavy: ['runBigTest'] },
    deferred: { io: ['runBigTest'] }
  }
  const problems = validateTestGroups(typo, ['runAddonTest', 'runBigTest'], {
    platforms: PLATFORMS
  })
  assert.ok(problems.some((p) => p.includes('not platforms') && p.includes('io')))
  assert.ok(problems.some((p) => p.startsWith('[ios]') && p.includes('runBigTest')))
})

test('a stale deferred entry is reported', () => {
  const stale = {
    ios: { light: ['runAddonTest'] },
    android: { light: ['runAddonTest'] },
    deferred: ['runRemovedTest']
  }
  const problems = validateTestGroups(stale, ['runAddonTest'], { platforms: PLATFORMS })
  assert.ok(problems.some((p) => p.includes('runRemovedTest') && p.includes('do not exist')))
})

test('"deferred" is a top-level key, never a platform', () => {
  // The Device Farm composites read only `.<platform>`, so a `deferred` key
  // nested inside ios/android would be scheduled as a real shard — and it is
  // otherwise indistinguishable from a shard, so every other rule passes.
  const nested = {
    ios: { light: ['runAddonTest'], deferred: ['runBigTest'] },
    iosWeekly: { heavy: ['runBigTest'] },
    android: { light: ['runAddonTest'], deferred: ['runBigTest'] }
  }
  const problems = validateTestGroups(nested, ['runAddonTest', 'runBigTest'], {
    platforms: PLATFORMS
  })

  assert.equal(problems.length, 2, 'exactly one problem per map that nests it')
  for (const source of ['ios', 'android']) {
    const reported = problems.some(
      (p) => p.startsWith(`[${source}]`) && p.includes('nested inside the platform map')
    )
    assert.ok(reported, `${source} must report the nested "deferred" key`)
  }
})

test('a file with no platform maps is reported rather than passing vacuously', () => {
  const problems = validateTestGroups({}, ['runAddonTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('declares no platform maps'))
})
