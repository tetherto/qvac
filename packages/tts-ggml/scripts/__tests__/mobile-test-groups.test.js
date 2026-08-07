'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const groups = require('../../test/mobile/test-groups.json')
const integrationAutoPath = path.resolve(__dirname, '../../test/mobile/integration.auto.cjs')

const EXPECTED_GROUPS = [
  'chatterbox',
  'chatterbox-mtl',
  'supertonic',
  'supertonic-mtl',
  'supertonic3',
  'parler',
  'lavasr',
  'cosyvoice3',
  'cross-model-compatibility'
]

const EXPECTED_ASSIGNMENTS = {
  chatterbox: ['runAddonTest', 'runChatterboxKvCacheGpuTest', 'runChatterboxSpeedTest'],
  'chatterbox-mtl': ['runChatterboxMtlTest'],
  supertonic: ['runSupertonicTest'],
  'supertonic-mtl': ['runSupertonicMtlTest'],
  supertonic3: ['runSupertonic3QuantTest'],
  parler: ['runParlerTest'],
  lavasr: ['runLavasrEnhancerTest'],
  cosyvoice3: ['runCosyvoice3Test'],
  'cross-model-compatibility': [
    'runMultipleRunsTest',
    'runGpuSmokeTest',
    'runOutputSampleRateTest'
  ]
}

const EXCLUDED_RUNNERS = [
  'runParlerWerTest',
  'runRtfBenchmarkTest',
  'runStreamingBenchmarkTest'
]

function sorted(values) {
  return [...values].sort()
}

function platformRunners(platform) {
  return Object.values(groups[platform]).flat()
}

function duplicateRunners(runners) {
  return runners.filter((runner, index) => runners.indexOf(runner) !== index)
}

function generatedRunners() {
  const content = fs.readFileSync(integrationAutoPath, 'utf8')
  return Array.from(
    content.matchAll(/^async function (run[A-Za-z0-9]+)\s*\(/gm),
    (match) => match[1]
  )
}

function generatedFunctionalRunners() {
  return generatedRunners().filter((runner) => !EXCLUDED_RUNNERS.includes(runner))
}

test('functional mobile groups have the approved model-family shards', () => {
  assert.deepEqual(Object.keys(groups.ios), EXPECTED_GROUPS)
  assert.deepEqual(Object.keys(groups.android), EXPECTED_GROUPS)
  assert.deepEqual(groups.ios, EXPECTED_ASSIGNMENTS)
  assert.deepEqual(groups.android, EXPECTED_ASSIGNMENTS)
})

test('every intended functional runner appears exactly once per platform', () => {
  const iosRunners = platformRunners('ios')
  const androidRunners = platformRunners('android')
  const expectedRunners = generatedFunctionalRunners()

  assert.deepEqual(sorted(iosRunners), sorted(expectedRunners))
  assert.deepEqual(sorted(androidRunners), sorted(expectedRunners))
  assert.deepEqual(duplicateRunners(iosRunners), [])
  assert.deepEqual(duplicateRunners(androidRunners), [])
})

test('excluded and benchmark runners do not enter functional shards', () => {
  const functionalRunners = platformRunners('ios').concat(platformRunners('android'))

  assert.deepEqual(
    sorted(generatedRunners().filter((runner) => EXCLUDED_RUNNERS.includes(runner))),
    sorted(EXCLUDED_RUNNERS)
  )
  assert.deepEqual(
    functionalRunners.filter((runner) => EXCLUDED_RUNNERS.includes(runner)),
    []
  )
})
