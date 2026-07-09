'use strict'

/**
 * Unit tests for the embed model pre-stage block generator (QVAC-21799).
 * Pure parse/build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/embed-llamacpp/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { extractModelConfigs, buildScript } = require('../generate-prestage-block')

const SAMPLE = `
const MODEL_CONFIGS = {
  'embeddinggemma-300M-Q8_0.gguf': {
    downloadUrl: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
    embeddingDimension: 768
  },
  'gte-large_fp16.gguf': {
    downloadUrl: 'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
    embeddingDimension: 1024
  }
}
`

test('extractModelConfigs pulls name + url pairs from MODEL_CONFIGS', () => {
  const models = extractModelConfigs(SAMPLE)
  assert.equal(models.length, 2)
  assert.deepEqual(models[0], {
    name: 'embeddinggemma-300M-Q8_0.gguf',
    url: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf'
  })
  assert.equal(models[1].name, 'gte-large_fp16.gguf')
})

test('extractModelConfigs dedupes repeated names', () => {
  const models = extractModelConfigs(SAMPLE + SAMPLE)
  assert.equal(models.length, 2)
})

test('buildScript stages every model to the prestage dir', () => {
  const script = buildScript([
    { name: 'a.gguf', url: 'https://example.com/a.gguf' },
    { name: 'b.gguf', url: 'https://example.com/b.gguf' }
  ])
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /stage "a\.gguf" "https:\/\/example\.com\/a\.gguf"/)
  assert.match(script, /stage "b\.gguf" "https:\/\/example\.com\/b\.gguf"/)
  assert.match(script, /adb push/)
  assert.match(script, /\[prestage\] done/)
})

test('parses the real embed MODEL_CONFIGS (includes embeddinggemma)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../test/integration/utils.js'), 'utf8')
  const models = extractModelConfigs(src)
  assert.ok(models.length >= 1)
  assert.ok(models.some((m) => m.name.includes('embeddinggemma')))
  assert.ok(models.every((m) => m.url.startsWith('https://')))
})
