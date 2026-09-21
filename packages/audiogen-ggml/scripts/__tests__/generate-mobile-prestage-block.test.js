'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ANDROID_MODEL_DIR,
  prestageEntries,
  presignEntries,
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

test('presignEntries resolves S3 keys on the modern GitHub runner', () => {
  const calls = []
  const signed = presignEntries(
    'model-bucket',
    [{ name: 'model.gguf', registryPath: 'models/model.gguf' }],
    '7200',
    (command, args) => {
      calls.push({ command, args })
      return 'https://models.example/model.gguf?signature=test\n'
    }
  )

  assert.deepEqual(signed, [
    {
      name: 'model.gguf',
      url: 'https://models.example/model.gguf?signature=test'
    }
  ])
  assert.deepEqual(calls, [
    {
      command: 'aws',
      args: ['s3', 'presign', 's3://model-bucket/models/model.gguf', '--expires-in', '7200']
    }
  ])
})

test('Android pre-stage downloads on the host and validates every adb push', () => {
  const script = buildAndroidScript([
    {
      name: 'model.gguf',
      url: 'https://models.example/model.gguf?signature=test'
    }
  ])

  assert.doesNotMatch(script, /QVACRegistryClient|rocksdb-native/)
  assert.match(script, /curl -fSL/)
  assert.match(script, /invalid GGUF magic/)
  assert.match(script, new RegExp(`PRESTAGE_DIR='${ANDROID_MODEL_DIR}'`))
  assert.match(script, /adb push/)
  assert.match(script, /adb shell test -s/)
})

test('asYamlBlock emits a literal block accepted by the shared action', () => {
  assert.equal(asYamlBlock('first\nsecond'), '|\n  first\n  second\n')
})
