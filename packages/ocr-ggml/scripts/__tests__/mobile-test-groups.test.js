'use strict'

/**
 * Unit tests for OCR mobile test-group coverage.
 *
 * Run locally:
 *   node --test packages/ocr-ggml/scripts/__tests__/mobile-test-groups.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  REQUIRED_PLATFORMS,
  FLAT_LABEL,
  generatedRunnerNames,
  legacyFlatGroups,
  validateTestGroups
} = require('../lib/validate-test-groups')
const { getGeneratedIntegrationRefs } = require('../validate-mobile-tests')
const groups = require('../../test/mobile/test-groups.json')

const integrationAutoPath = path.resolve(__dirname, '../../test/mobile/integration.auto.cjs')

function committedRunners() {
  return generatedRunnerNames(fs.readFileSync(integrationAutoPath, 'utf8'))
}

test('committed test groups cover every generated runner', () => {
  assert.deepEqual(
    validateTestGroups(groups, committedRunners(), { platforms: REQUIRED_PLATFORMS }),
    []
  )
})

test('runner extractor reads the committed generated file', () => {
  const runners = committedRunners()
  assert.ok(runners.length > 0)
  assert.ok(runners.includes('runOcrBasicTest'))
  assert.ok(runners.every((name) => name.startsWith('run')))
})

test('runner extractor returns an empty list for empty content', () => {
  assert.deepEqual(generatedRunnerNames(''), [])
})

test('integration reference extractor reads generated module paths', () => {
  const content = [
    "return runIntegrationModule('../integration/first.test.js', options)",
    "return runIntegrationModule('../integration/second.test.js')"
  ].join('\n')
  assert.deepEqual([...getGeneratedIntegrationRefs(content)], ['first.test.js', 'second.test.js'])
})

test('coverage is checked independently for every platform', () => {
  const input = {
    android: { regular: ['runOcrBasicTest', 'runOnlyOnAndroidTest'] },
    ios: { regular: ['runOcrBasicTest'] }
  }
  const problems = validateTestGroups(input, ['runOcrBasicTest', 'runOnlyOnAndroidTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith('[ios]'))
})

test('android-only runners are deferred only on ios', () => {
  assert.deepEqual(groups.deferred, {
    ios: ['runAndroidOpenclTest', 'runAndroidVulkanTest', 'runDoctrWarmTest']
  })
  const ios = Object.values(groups.ios).flat()
  const android = Object.values(groups.android).flat()
  assert.ok(groups.deferred.ios.every((name) => !ios.includes(name)))
  assert.ok(groups.deferred.ios.every((name) => android.includes(name)))
})

test('deferred nested inside platform maps is reported', () => {
  const input = {
    android: { regular: ['runOcrBasicTest'], deferred: ['runAndroidVulkanTest'] },
    ios: { regular: ['runOcrBasicTest'], deferred: ['runAndroidVulkanTest'] }
  }
  const problems = validateTestGroups(input, ['runOcrBasicTest', 'runAndroidVulkanTest'])
  assert.equal(problems.length, 2)
  assert.ok(problems.some((problem) => problem.startsWith('[android]')))
  assert.ok(problems.some((problem) => problem.startsWith('[ios]')))
})

test('deferral can be scoped to one platform', () => {
  const input = {
    android: { regular: ['runOcrBasicTest', 'runAndroidVulkanTest'] },
    ios: { regular: ['runOcrBasicTest'] },
    deferred: { ios: ['runAndroidVulkanTest'] }
  }
  assert.deepEqual(validateTestGroups(input, ['runOcrBasicTest', 'runAndroidVulkanTest']), [])

  input.deferred = ['runAndroidVulkanTest']
  const problems = validateTestGroups(input, ['runOcrBasicTest', 'runAndroidVulkanTest'])
  assert.ok(problems.some((problem) => problem.startsWith('[android]')))
  assert.ok(problems.some((problem) => problem.includes('both scheduled')))
})

test('a deferred map keyed by a non-platform is reported', () => {
  const input = {
    android: { regular: ['runOcrBasicTest', 'runAndroidVulkanTest'] },
    ios: { regular: ['runOcrBasicTest'] },
    deferred: { io: ['runAndroidVulkanTest'] }
  }
  const problems = validateTestGroups(input, ['runOcrBasicTest', 'runAndroidVulkanTest'])
  assert.ok(problems.some((problem) => problem.includes('not platforms')))
  assert.ok(problems.some((problem) => problem.startsWith('[ios]')))
})

test('a top-level map that is not a required platform is reported', () => {
  const input = {
    android: { regular: ['runA'] },
    ios: { regular: ['runA'] },
    notes: { regular: ['runBogus'] }
  }
  const problems = validateTestGroups(input, ['runA'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('notes'))
})

test('a missing required platform is reported by the default list', () => {
  const input = { android: { regular: ['runOcrBasicTest'] } }
  const problems = validateTestGroups(input, ['runOcrBasicTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith('[ios]'))
  assert.ok(problems[0].includes('has no `{'))
})

test('options.platforms overrides the default platform list', () => {
  const input = { android: { regular: ['runOcrBasicTest'] } }
  assert.deepEqual(validateTestGroups(input, ['runOcrBasicTest'], { platforms: ['android'] }), [])
})

test('an empty options.platforms list uses the required platforms', () => {
  const input = { android: { regular: ['runOcrBasicTest'] } }
  const problems = validateTestGroups(input, ['runOcrBasicTest'], { platforms: [] })
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith('[ios]'))
})

test('an unassigned runner is reported on every platform', () => {
  const problems = validateTestGroups(groups, [...committedRunners(), 'runBrandNewTest'])
  assert.equal(problems.length, 2)
  assert.ok(problems.every((problem) => problem.includes('runBrandNewTest')))
})

test('a group reference to an unknown runner is reported', () => {
  const input = {
    android: { regular: ['runOcrBasicTest', 'runTypoTest'] },
    ios: { regular: ['runOcrBasicTest'] }
  }
  const problems = validateTestGroups(input, ['runOcrBasicTest'])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('runTypoTest'))
  assert.ok(problems[0].includes('non-existent tests'))
})

test('a stale flat deferred entry is reported', () => {
  const input = { regular: ['runOcrBasicTest'], deferred: ['runRemovedTest'] }
  const problems = validateTestGroups(input, ['runOcrBasicTest'])
  assert.ok(problems.some((problem) => problem.includes('runRemovedTest')))
  assert.ok(problems.some((problem) => problem.includes('do not exist')))
})

test('a stale mapped deferred entry is reported', () => {
  const input = {
    android: { regular: ['runOcrBasicTest'] },
    ios: { regular: ['runOcrBasicTest'] },
    deferred: { ios: ['runRemovedTest'] }
  }
  const problems = validateTestGroups(input, ['runOcrBasicTest'])
  assert.ok(problems.some((problem) => problem.includes('runRemovedTest')))
  assert.ok(problems.some((problem) => problem.includes('do not exist')))
})

test('a runner cannot be both scheduled and deferred', () => {
  const input = {
    android: { regular: ['runOcrBasicTest'] },
    ios: { regular: ['runOcrBasicTest'] },
    deferred: ['runOcrBasicTest']
  }
  const problems = validateTestGroups(input, ['runOcrBasicTest'])
  assert.equal(problems.length, 2)
  assert.ok(problems.every((problem) => problem.includes('both scheduled and listed')))
})

test('perf_report_filter remains ignored metadata', () => {
  assert.equal(typeof groups.perf_report_filter, 'string')
  const input = {
    android: { regular: ['runOcrBasicTest'] },
    ios: { regular: ['runOcrBasicTest'] },
    perf_report_filter: 'clinical_chemistry'
  }
  assert.deepEqual(validateTestGroups(input, ['runOcrBasicTest']), [])
})

test('legacy flat groups validate cleanly', () => {
  const input = {
    perf: ['runDoctrClinicalChemistryTest'],
    regularA: ['runOcrBasicTest'],
    perf_report_filter: 'clinical_chemistry'
  }
  assert.deepEqual(Object.keys(legacyFlatGroups(input)), ['perf', 'regularA'])
  assert.deepEqual(
    validateTestGroups(input, ['runDoctrClinicalChemistryTest', 'runOcrBasicTest']),
    []
  )
})

test('legacy flat groups report an unassigned runner', () => {
  const problems = validateTestGroups({ regularA: ['runOcrBasicTest'] }, [
    'runOcrBasicTest',
    'runBrandNewTest'
  ])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].startsWith(`[${FLAT_LABEL}]`))
})

test('legacy flat groups honour a top-level deferred list', () => {
  const input = {
    regularA: ['runOcrBasicTest'],
    deferred: ['runAndroidVulkanTest']
  }
  assert.deepEqual(validateTestGroups(input, ['runOcrBasicTest', 'runAndroidVulkanTest']), [])
})

test('a file containing only metadata cannot pass vacuously', () => {
  const problems = validateTestGroups({ perf_report_filter: 'clinical_chemistry' }, [
    'runOcrBasicTest'
  ])
  assert.deepEqual(problems, ['test-groups.json declares no test groups.'])
})
