'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const groups = require('../../test/mobile/test-groups.json')
const perfRunners = require('../../test/mobile/perf-tests.json')
const { TEST_MODELS } = require('../generate-mobile-model-manifest')
const { WHISPER_TEST_MODEL_NAMES } = require('../generate-prestage-block')

const integrationAutoPath = path.resolve(__dirname, '../../test/mobile/integration.auto.cjs')
const EXPECTED_GROUPS = ['whisper-perf', 'parakeet-perf']

function sorted(values) {
  return [...values].sort()
}

function generatedRunners() {
  const content = fs.readFileSync(integrationAutoPath, 'utf8')
  return Array.from(
    content.matchAll(/^async function (run[A-Za-z0-9]+)\s*\(/gm),
    (match) => match[1]
  )
}

function platformRunners(platform) {
  return Object.values(groups[platform]).flat()
}

function duplicateRunners(runners) {
  return runners.filter((runner, index) => runners.indexOf(runner) !== index)
}

test('ASR mobile groups split runners into Whisper and Parakeet shards', () => {
  for (const platform of ['ios', 'android']) {
    assert.deepEqual(Object.keys(groups[platform]), EXPECTED_GROUPS)
    assert.equal(groups[platform]['whisper-perf'].length, 13)
    assert.equal(groups[platform]['parakeet-perf'].length, 23)
    assert.ok(groups[platform]['whisper-perf'].every((runner) => !runner.startsWith('runParakeet')))
    assert.ok(groups[platform]['parakeet-perf'].every((runner) => runner.startsWith('runParakeet')))
  }
  assert.deepEqual(groups.ios, groups.android)
})

test('every generated ASR mobile runner appears exactly once per platform', () => {
  const expected = generatedRunners()

  for (const platform of ['ios', 'android']) {
    const runners = platformRunners(platform)
    assert.deepEqual(sorted(runners), sorted(expected))
    assert.deepEqual(duplicateRunners(runners), [])
  }
})

test('functional ASR shards retain every mobile performance runner', () => {
  for (const platform of ['ios', 'android']) {
    const runners = new Set(platformRunners(platform))
    assert.deepEqual(
      perfRunners.filter((runner) => !runners.has(runner)),
      []
    )
  }
})

test('every shard runner has an explicit model or model-free manifest entry', () => {
  for (const platform of ['ios', 'android']) {
    assert.deepEqual(
      sorted(Object.keys(WHISPER_TEST_MODEL_NAMES)),
      sorted(groups[platform]['whisper-perf'])
    )
    assert.deepEqual(
      sorted(Object.keys(TEST_MODELS)),
      sorted(groups[platform]['parakeet-perf'])
    )
  }
})
