import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PREBUILD_KEYS, CPP_TEST_KEYS } from '../prebuild-status/lib.mjs'

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
