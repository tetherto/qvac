'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  REQUIRED_PLATFORMS,
  generatedRunnerNames,
  platformFamily,
  isOverrideOnly,
  validateTestGroups
} = require('../lib/validate-test-groups')

const packageRoot = path.resolve(__dirname, '..', '..')
const groups = require('../../test/mobile/test-groups.json')

function committedRunners() {
  const content = fs.readFileSync(
    path.join(packageRoot, 'test/mobile/integration.auto.cjs'),
    'utf8'
  )
  return generatedRunnerNames(content)
}

test('committed groups cover every generated mobile runner', () => {
  assert.deepEqual(
    validateTestGroups(groups, committedRunners(), { platforms: REQUIRED_PLATFORMS }),
    []
  )
})

test('generated runner extractor reads the committed mobile file', () => {
  const runners = committedRunners()
  assert.ok(runners.length > 0)
  assert.ok(runners.includes('runApiBehaviorTest'))
  assert.ok(runners.every((name) => name.startsWith('run')))
})

test('weekly groups contain runners absent from the daily groups', () => {
  const daily = new Set(Object.values(groups.ios).flat())
  assert.ok(
    Object.values(groups.iosWeekly)
      .flat()
      .some((name) => !daily.has(name))
  )
})

test('coverage is pooled across daily and weekly maps in each family', () => {
  const input = {
    ios: { light: ['runDailyTest'] },
    iosWeekly: { heavy: ['runWeeklyTest'] },
    android: { light: ['runDailyTest'], heavy: ['runWeeklyTest'] }
  }
  assert.deepEqual(validateTestGroups(input, ['runDailyTest', 'runWeeklyTest']), [])
})

test('an unassigned runner is reported once per platform family', () => {
  const problems = validateTestGroups(groups, [...committedRunners(), 'runBrandNewTest'])
  assert.equal(problems.length, 2)
  assert.ok(problems.some((problem) => problem.startsWith('[ios]')))
  assert.ok(problems.some((problem) => problem.startsWith('[android]')))
  assert.ok(problems.every((problem) => problem.includes('runBrandNewTest')))
})

test('benchmark shards and desktop-only finetuning are exempt from coverage', () => {
  assert.equal(isOverrideOnly('runBenchmarkPerf4bQ80F16Test'), true)
  assert.equal(isOverrideOnly('runFinetuningMoeTest'), true)
  assert.equal(isOverrideOnly('runBrandNewTest'), false)
  assert.deepEqual(
    validateTestGroups(groups, [
      ...committedRunners(),
      'runBenchmarkPerf4bQ80F16Test',
      'runFinetuningMoeTest'
    ]),
    []
  )
})

test('an override-only runner referenced by a group must exist', () => {
  const input = {
    ios: { benchmark: ['runBenchmarkPerfGoneTest'] },
    android: { benchmark: ['runBenchmarkPerfGoneTest'] }
  }
  const problems = validateTestGroups(input, [])
  assert.equal(problems.length, 2)
  assert.ok(problems.every((problem) => problem.includes('non-existent tests')))
})

test('platformFamily removes only a trailing Weekly suffix', () => {
  assert.equal(platformFamily('iosWeekly'), 'ios')
  assert.equal(platformFamily('android'), 'android')
  assert.equal(platformFamily('weeklyIos'), 'weeklyIos')
})

test('a required platform without a map is reported', () => {
  const problems = validateTestGroups({ ios: { light: ['runDailyTest'] } }, ['runDailyTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith('[android]'))
  assert.ok(problems[0].includes('has no `{'))
})

test('a stray platform map is named directly', () => {
  const input = {
    ios: { light: ['runDailyTest'] },
    iosWekly: { heavy: ['runWeeklyTest'] },
    android: { light: ['runDailyTest'], heavy: ['runWeeklyTest'] }
  }
  const problems = validateTestGroups(input, ['runDailyTest', 'runWeeklyTest'])
  assert.equal(problems.length, 2)
  assert.ok(problems[0].includes('iosWekly'))
  assert.ok(problems[1].startsWith('[ios]'))
})

test('a group reference to an unknown runner is reported', () => {
  const input = {
    ios: { light: ['runDailyTest', 'runTypoTest'] },
    android: { light: ['runDailyTest'] }
  }
  const problems = validateTestGroups(input, ['runDailyTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('runTypoTest'))
  assert.ok(problems[0].includes('non-existent tests'))
})

test('non-object top-level metadata is ignored', () => {
  const input = {
    ios: { light: ['runDailyTest'] },
    android: { light: ['runDailyTest'] },
    reportFilter: 'daily'
  }
  assert.deepEqual(validateTestGroups(input, ['runDailyTest']), [])
})

test('an empty groups object reports every required platform', () => {
  const problems = validateTestGroups({}, ['runDailyTest'])
  assert.equal(problems.length, 2)
  assert.ok(problems.every((problem) => problem.includes('has no `{')))
})

test('options.platforms overrides the required platform list', () => {
  const input = { ios: { light: ['runDailyTest'] } }
  assert.deepEqual(validateTestGroups(input, ['runDailyTest'], { platforms: ['ios'] }), [])
})

test('an empty options.platforms list uses the required platforms', () => {
  const input = { ios: { light: ['runDailyTest'] } }
  const problems = validateTestGroups(input, ['runDailyTest'], { platforms: [] })
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith('[android]'))
})
