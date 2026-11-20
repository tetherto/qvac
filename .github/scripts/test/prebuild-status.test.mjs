import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PREBUILD_KEYS, CPP_TEST_KEYS, resolvePublishState } from '../prebuild-status/lib.mjs'

test('resolvePublishState: a real success or artifact reuse always passes', () => {
  assert.equal(resolvePublishState('success', 'false', 'success', 'true'), 'success')
  assert.equal(resolvePublishState('failure', 'true', 'success', 'true'), 'success', 'artifact reuse counts as success')
  assert.equal(resolvePublishState('skipped', 'true', 'success', 'true'), 'success', 'reuse-hit skip is a real pass')
})

test('resolvePublishState: a skipped prebuild passes ONLY as a legit no-label skip', () => {
  // ci-router ran and deliberately chose not to build (no prebuild label).
  assert.equal(resolvePublishState('skipped', 'false', 'success', 'false'), 'success')
})

test('resolvePublishState: a failure-induced skip fails closed (Ian: upstream failure must not read as success)', () => {
  // ci-router failed, so run_prebuilds never resolved and prebuild fell through
  // to skipped - this must NOT be published as a green prebuild.
  assert.equal(resolvePublishState('skipped', 'false', 'failure', ''), 'failure')
  // ci-router itself skipped (e.g. PR not authorized) -> not a no-label decision.
  assert.equal(resolvePublishState('skipped', 'false', 'skipped', ''), 'failure')
  assert.equal(resolvePublishState('skipped', 'false', '', ''), 'failure')
  // Skipped while ci-router said run_prebuilds=true is not a no-label skip.
  assert.equal(resolvePublishState('skipped', 'false', 'success', 'true'), 'failure')
  assert.equal(resolvePublishState('skipped', 'false', 'success', ''), 'failure')
})

test('resolvePublishState: a real prebuild failure fails', () => {
  assert.equal(resolvePublishState('failure', 'false', 'success', 'true'), 'failure')
  assert.equal(resolvePublishState('cancelled', '', 'success', 'true'), 'failure')
  assert.equal(resolvePublishState(undefined, undefined, undefined, undefined), 'failure')
})

test('PREBUILD_KEYS covers the merge-guard allowlist', () => {
  assert.equal(PREBUILD_KEYS.length, 14)
  assert.ok(PREBUILD_KEYS.includes('ggml-rpc-server'))
  assert.ok(PREBUILD_KEYS.includes('tts-ggml'))
  assert.ok(PREBUILD_KEYS.includes('turbovec-ggml'))
  assert.ok(PREBUILD_KEYS.includes('vla-ggml'))
})

test('CPP_TEST_KEYS covers C++-test packages', () => {
  assert.equal(CPP_TEST_KEYS.length, 14)
  assert.ok(CPP_TEST_KEYS.includes('asr-ggml'))
  assert.ok(CPP_TEST_KEYS.includes('bci-whispercpp'))
  assert.ok(CPP_TEST_KEYS.includes('audiogen-ggml'))
  assert.ok(CPP_TEST_KEYS.includes('ggml-rpc-server'))
  assert.ok(CPP_TEST_KEYS.includes('turbovec-ggml'))
  assert.ok(CPP_TEST_KEYS.includes('vla-ggml'))
  assert.ok(!CPP_TEST_KEYS.includes('fabric'))
})

test('OCR declares a failable Linux C++ test producer for its status key', () => {
  const project = JSON.parse(
    readFileSync(new URL('../../../packages/ocr-ggml/project.json', import.meta.url), 'utf8'),
  )
  // On the CI contract, pr-build-test.yml's cpp:tests leg is the producer.
  assert.ok(CPP_TEST_KEYS.includes('ocr-ggml'))
  assert.ok(project.targets['cpp:tests'].configurations['linux-x64'])
})
