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

const { modelsFromManifest, buildScript } = require('../generate-prestage-block')
const realManifest = require('../../test/integration/models.manifest.json')

const SAMPLE = {
  models: {
    'embeddinggemma-300M-Q8_0.gguf': {
      urls: [
        'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/0123456789012345678901234567890123456789/embeddinggemma-300M-Q8_0.gguf'
      ]
    },
    'gte-large_fp16.gguf': {
      urls: [
        'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/0123456789012345678901234567890123456789/gte-large_fp16.gguf'
      ]
    }
  }
}

test('modelsFromManifest pulls name + url pairs from the integration manifest', () => {
  const models = modelsFromManifest(SAMPLE)
  assert.equal(models.length, 2)
  assert.deepEqual(models[0], {
    name: 'embeddinggemma-300M-Q8_0.gguf',
    url: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/0123456789012345678901234567890123456789/embeddinggemma-300M-Q8_0.gguf'
  })
  assert.equal(models[1].name, 'gte-large_fp16.gguf')
})

test('modelsFromManifest rejects entries without a usable URL', () => {
  assert.throws(
    () => modelsFromManifest({ models: { 'broken.gguf': { urls: [] } } }),
    /no usable pinned manifest URL/
  )
  assert.throws(
    () =>
      modelsFromManifest({
        models: {
          'mutable.gguf': {
            urls: ['https://huggingface.co/example/model/resolve/main/mutable.gguf']
          }
        }
      }),
    /no usable pinned manifest URL/
  )
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

test('real integration manifest drives the complete pre-stage set', () => {
  const models = modelsFromManifest(realManifest)
  assert.equal(models.length, Object.keys(realManifest.models).length)
  assert.ok(models.some((model) => model.name.includes('embeddinggemma')))
})
