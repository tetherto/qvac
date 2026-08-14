'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ANDROID_MODEL_DIR,
  prestageEntries,
  buildAndroidScript,
  asYamlBlock
} = require('../generate-mobile-prestage-block')

test('prestageEntries selects the four turbo-q4 pipeline stages', () => {
  const entries = prestageEntries()

  assert.equal(entries.length, 4)
  assert.deepEqual(
    entries.map(({ name }) => name),
    [
      'Qwen3-Embedding-0.6B-Q8_0.gguf',
      'acestep-5Hz-lm-0.6B-Q8_0.gguf',
      'acestep-v15-turbo-Q4_K_M.gguf',
      'vae-BF16.gguf'
    ]
  )
  for (const entry of entries) {
    assert.match(entry.registryPath, /qvac_models_compiled\/ggml\/acestep/)
  }
})

test('Android pre-stage downloads on the host and validates every adb push', () => {
  const script = buildAndroidScript()

  assert.match(script, /QVACRegistryClient/)
  assert.match(script, /downloadModel/)
  assert.match(script, /magic\.toString\('latin1'\) !== 'GGUF'/)
  assert.match(script, new RegExp(`PRESTAGE_DIR='${ANDROID_MODEL_DIR}'`))
  assert.match(script, /adb push/)
  assert.match(script, /adb shell test -s/)
})

test('asYamlBlock emits a literal block accepted by the shared action', () => {
  assert.equal(asYamlBlock('first\nsecond'), '|\n  first\n  second\n')
})
