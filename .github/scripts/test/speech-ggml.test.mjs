import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GGML_SPEECH_PORT,
  SPEECH_ADDONS,
  checkAddonList,
  checkPins,
  checkPlans,
  checkRecordedBuilds,
  findPin,
  formatPortVersion,
  listInstalledBuilds,
  parsePlannedPort,
  recordedGgmlSpeech,
  summarizePlans,
  summarizeRecordedBuilds,
} from '../lib/speech-ggml.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const GGML_SPEECH_PIN = { name: 'ggml-speech', version: '2026-10-07', 'port-version': 1 }
const SPEECH_CPP_PIN = { name: 'speech-cpp', version: '2026-10-09' }

function addon(name, { overrides = [GGML_SPEECH_PIN, SPEECH_CPP_PIN], dependencies = [], recorded = '2026-10-07#1' } = {}) {
  return {
    name,
    vcpkg: { dependencies, overrides },
    manifest: recorded === null ? { name } : { name, qvac: { 'ggml-speech': recorded } },
  }
}

function readAddon({ name, dir }) {
  const read = (file) => JSON.parse(readFileSync(join(repoRoot, dir, file), 'utf8'))
  return { name, vcpkg: read('vcpkg.json'), manifest: read('package.json') }
}

const ANDROID_PLAN = `The following packages will be built and installed:
    ggml-speech[core,vulkan,opencl]:arm64-android@2026-10-07#1 -- git+https://github.com/tetherto/qvac-registry-vcpkg.git@b362323e
  * opencl:arm64-android@2024.10.24 -- git+https://github.com/tetherto/qvac-registry-vcpkg.git@242b711b
    speech-cpp[core,opencl,tts,vulkan]:arm64-android@2026-10-09 -- git+https://github.com/tetherto/qvac-registry-vcpkg.git@9aa11606
`

function plan(addonName, triplet, features, version = '2026-10-07#1') {
  return { addon: addonName, triplet, planned: { features, triplet, version } }
}

test('the speech addons in the repo pin one ggml-speech and speech-cpp and record that ggml-speech', () => {
  assert.deepEqual(checkPins(SPEECH_ADDONS.map(readAddon)), [])
})

test('formats override versions the way vcpkg prints them', () => {
  assert.equal(formatPortVersion(GGML_SPEECH_PIN), '2026-10-07#1')
  assert.equal(formatPortVersion(SPEECH_CPP_PIN), '2026-10-09')
  assert.equal(formatPortVersion({ name: 'x', 'version-date': '2026-10-02', 'port-version': 0 }), '2026-10-02')
})

test('finds a pin only when one overrides entry names the port', () => {
  assert.equal(findPin({ overrides: [GGML_SPEECH_PIN] }, GGML_SPEECH_PORT), '2026-10-07#1')
  assert.equal(findPin({}, GGML_SPEECH_PORT), null)
  assert.equal(findPin({ overrides: [GGML_SPEECH_PIN, GGML_SPEECH_PIN] }, GGML_SPEECH_PORT), null)
})

test('reads the recorded ggml-speech build from package.json', () => {
  assert.equal(recordedGgmlSpeech({ qvac: { 'ggml-speech': '2026-10-07#1' } }), '2026-10-07#1')
  assert.equal(recordedGgmlSpeech({ name: '@qvac/asr-ggml' }), null)
  assert.equal(recordedGgmlSpeech(undefined), null)
})

test('accepts addons that pin and record the same builds', () => {
  assert.deepEqual(checkPins([addon('@qvac/a'), addon('@qvac/b')]), [])
})

test('rejects an addon without overrides', () => {
  assert.deepEqual(checkPins([addon('@qvac/a', { overrides: [] })]), [
    '@qvac/a: vcpkg.json needs exactly one overrides entry for ggml-speech',
    '@qvac/a: vcpkg.json needs exactly one overrides entry for speech-cpp',
  ])
})

test('rejects a version floor on a pinned port, once per floor', () => {
  const floor = { name: 'speech-cpp', 'version>=': '2026-10-09', 'default-features': false }
  const cuda = { dependencies: [floor] }
  const errors = checkPins([
    { ...addon('@qvac/a'), vcpkg: { dependencies: [floor, floor, 'gtest'], features: { cuda }, overrides: [GGML_SPEECH_PIN, SPEECH_CPP_PIN] } },
  ])
  assert.deepEqual(errors, [
    '@qvac/a: vcpkg.json declares speech-cpp version>= 2026-10-09; set the version in its overrides entry instead',
  ])
})

test('ignores floors on other ports', () => {
  const dependencies = [{ name: 'qvac-lint-cpp', 'version>=': '1.4.4#3' }]
  assert.deepEqual(checkPins([addon('@qvac/a', { dependencies })]), [])
})

test('rejects a recorded ggml-speech that differs from the pin', () => {
  assert.deepEqual(checkPins([addon('@qvac/a', { recorded: '2026-10-06' })]), [
    '@qvac/a: package.json qvac["ggml-speech"] is 2026-10-06, but vcpkg.json pins ggml-speech 2026-10-07#1',
  ])
  assert.deepEqual(checkPins([addon('@qvac/a', { recorded: null })]), [
    '@qvac/a: package.json qvac["ggml-speech"] is missing, but vcpkg.json pins ggml-speech 2026-10-07#1',
  ])
})

test('rejects addons that pin different versions of a port', () => {
  const older = { name: 'speech-cpp', version: '2026-10-07', 'port-version': 2 }
  const errors = checkPins([
    addon('@qvac/a'),
    addon('@qvac/b'),
    addon('@qvac/c', { overrides: [GGML_SPEECH_PIN, older] }),
  ])
  assert.deepEqual(errors, [
    'speech-cpp is pinned to 2 versions: 2026-10-09 (@qvac/a, @qvac/b); 2026-10-07#2 (@qvac/c)',
  ])
})

test('parses the planned port, its sorted features, triplet and version', () => {
  assert.deepEqual(parsePlannedPort(ANDROID_PLAN, 'ggml-speech'), {
    features: ['core', 'opencl', 'vulkan'],
    triplet: 'arm64-android',
    version: '2026-10-07#1',
  })
  assert.deepEqual(parsePlannedPort(ANDROID_PLAN, 'opencl'), {
    features: [],
    triplet: 'arm64-android',
    version: '2024.10.24',
  })
  assert.equal(parsePlannedPort(ANDROID_PLAN, 'speech'), null)
  assert.equal(parsePlannedPort('', 'ggml-speech'), null)
})

test('accepts one ggml-speech build per triplet', () => {
  const plans = [
    plan('@qvac/a', 'arm64-android', ['core', 'opencl', 'vulkan']),
    plan('@qvac/b', 'arm64-android', ['core', 'opencl', 'vulkan']),
    plan('@qvac/a', 'arm64-ios', ['core', 'metal']),
    plan('@qvac/b', 'arm64-ios', ['core', 'metal']),
  ]
  assert.deepEqual(checkPlans(plans, '2026-10-07#1'), [])
  assert.deepEqual(summarizePlans(plans), [
    'arm64-android: ggml-speech[core,opencl,vulkan]@2026-10-07#1',
    'arm64-ios: ggml-speech[core,metal]@2026-10-07#1',
  ])
})

test('rejects different ggml-speech features on one triplet', () => {
  const plans = [
    plan('@qvac/a', 'arm64-android', ['core', 'opencl', 'vulkan']),
    plan('@qvac/b', 'arm64-android', ['core', 'vulkan']),
    plan('@qvac/a', 'x64-linux', ['core', 'vulkan']),
    plan('@qvac/b', 'x64-linux', ['core', 'vulkan']),
  ]
  assert.deepEqual(checkPlans(plans, '2026-10-07#1'), [
    'arm64-android: the speech addons plan 2 ggml-speech builds: ' +
      'ggml-speech[core,opencl,vulkan]@2026-10-07#1 (@qvac/a); ggml-speech[core,vulkan]@2026-10-07#1 (@qvac/b)',
  ])
})

test('rejects a planned ggml-speech that is not the pinned one', () => {
  const plans = [plan('@qvac/a', 'x64-linux', ['core', 'vulkan'], '2026-10-06')]
  assert.deepEqual(checkPlans(plans, '2026-10-07#1'), [
    'x64-linux: @qvac/a plans ggml-speech@2026-10-06, but the override pins 2026-10-07#1',
  ])
})

test('lists every installed version of every speech addon with its recorded build', () => {
  const installed = new Map([
    ['@qvac/asr-ggml', new Map([['0.9.0', ['hoisted']], ['0.3.3', ['@qvac/tts-ggml@0.12.0']]])],
    ['@qvac/tts-ggml', new Map([['0.12.0', ['hoisted']]])],
    ['@qvac/bci-whispercpp', new Map()],
  ])
  const recorded = { '@qvac/asr-ggml@0.9.0': '2026-10-07#1', '@qvac/tts-ggml@0.12.0': '2026-10-07#1' }
  const builds = listInstalledBuilds(installed, (name, version) => recorded[`${name}@${version}`] ?? null)
  assert.deepEqual(builds, [
    { id: '@qvac/asr-ggml@0.9.0', ggmlSpeech: '2026-10-07#1' },
    { id: '@qvac/asr-ggml@0.3.3', ggmlSpeech: null },
    { id: '@qvac/tts-ggml@0.12.0', ggmlSpeech: '2026-10-07#1' },
  ])
  assert.equal(
    summarizeRecordedBuilds(builds),
    'ggml-speech: 2026-10-07#1 (@qvac/asr-ggml@0.9.0, @qvac/tts-ggml@0.12.0); not recorded (@qvac/asr-ggml@0.3.3)',
  )
  assert.equal(summarizeRecordedBuilds([]), 'ggml-speech: no speech addons installed')
})

test('accepts installed speech addons that record one build', () => {
  const builds = [
    { id: '@qvac/asr-ggml@0.9.0', ggmlSpeech: '2026-10-07#1' },
    { id: '@qvac/tts-ggml@0.12.0', ggmlSpeech: '2026-10-07#1' },
  ]
  assert.deepEqual(checkRecordedBuilds(builds), { errors: [], warnings: [] })
})

test('rejects installed speech addons that record different builds', () => {
  const builds = [
    { id: '@qvac/asr-ggml@0.9.0', ggmlSpeech: '2026-10-07#1' },
    { id: '@qvac/tts-ggml@0.13.0', ggmlSpeech: '2026-10-20' },
    { id: '@qvac/bci-whispercpp@0.12.0', ggmlSpeech: '2026-10-07#1' },
  ]
  assert.deepEqual(checkRecordedBuilds(builds).errors, [
    'speech addons built from 2 ggml-speech versions: ' +
      '2026-10-07#1 (@qvac/asr-ggml@0.9.0, @qvac/bci-whispercpp@0.12.0); 2026-10-20 (@qvac/tts-ggml@0.13.0)',
  ])
})

test('warns about an unrecorded speech addon only when another one is installed', () => {
  const unrecorded = { id: '@qvac/asr-ggml@0.3.3', ggmlSpeech: null }
  const recorded = { id: '@qvac/tts-ggml@0.12.0', ggmlSpeech: '2026-10-07#1' }
  assert.deepEqual(checkRecordedBuilds([unrecorded, recorded]), {
    errors: [],
    warnings: ['@qvac/asr-ggml@0.3.3 does not record the ggml-speech build it ships, so it cannot be checked'],
  })
  assert.deepEqual(checkRecordedBuilds([unrecorded]), { errors: [], warnings: [] })
})

test('every package in the repo that depends on ggml-speech or speech-cpp is a listed speech addon', () => {
  const packages = readdirSync(join(repoRoot, 'packages'))
    .map((name) => `packages/${name}`)
    .filter((dir) => existsSync(join(repoRoot, dir, 'vcpkg.json')))
    .map((dir) => ({ dir, vcpkg: JSON.parse(readFileSync(join(repoRoot, dir, 'vcpkg.json'), 'utf8')) }))
  assert.deepEqual(checkAddonList(packages), [])
})

test('rejects an unlisted package that depends on a pinned port', () => {
  const featureOnly = { features: { speech: { dependencies: [{ name: 'ggml-speech' }] } } }
  const packages = [
    { dir: 'packages/asr-ggml', vcpkg: { dependencies: ['speech-cpp'] } },
    { dir: 'packages/diarize-ggml', vcpkg: { dependencies: ['speech-cpp'] } },
    { dir: 'packages/music-ggml', vcpkg: featureOnly },
    { dir: 'packages/llm-llamacpp', vcpkg: { dependencies: [{ name: 'qvac-fabric' }] } },
  ]
  assert.deepEqual(checkAddonList(packages), [
    'packages/diarize-ggml depends on ggml-speech or speech-cpp but is not a listed speech addon; add it to ' +
      'SPEECH_ADDONS in .github/scripts/lib/speech-ggml.mjs and in build-mobile-app/check-speech-ggml-builds.mjs',
    'packages/music-ggml depends on ggml-speech or speech-cpp but is not a listed speech addon; add it to ' +
      'SPEECH_ADDONS in .github/scripts/lib/speech-ggml.mjs and in build-mobile-app/check-speech-ggml-builds.mjs',
  ])
})
