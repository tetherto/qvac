'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { resolvePinnedManifest, buildScript } = require('../generate-prestage-block')
const mobileManifest = require('../../test/mobile/model-manifest.json')
const integrationManifest = require('../../test/integration/models.manifest.json')

test('resolvePinnedManifest replaces mobile URLs with pinned integration URLs', () => {
  const resolved = resolvePinnedManifest(
    {
      runExampleTest: [
        {
          name: 'model.gguf',
          url: 'https://huggingface.co/example/model/resolve/main/model.gguf'
        }
      ]
    },
    {
      models: {
        'model.gguf': {
          urls: [
            'https://huggingface.co/example/model/resolve/0123456789012345678901234567890123456789/model.gguf'
          ]
        }
      }
    }
  )

  assert.equal(
    resolved.runExampleTest[0].url,
    'https://huggingface.co/example/model/resolve/0123456789012345678901234567890123456789/model.gguf'
  )
})

test('resolvePinnedManifest rejects missing or mutable integration URLs', () => {
  const mobile = {
    runExampleTest: [{ name: 'model.gguf', url: 'https://example.com/model.gguf' }]
  }

  assert.throws(
    () => resolvePinnedManifest(mobile, { models: {} }),
    /model\.gguf has no usable pinned manifest URL/
  )
  assert.throws(
    () =>
      resolvePinnedManifest(mobile, {
        models: {
          'model.gguf': {
            urls: ['https://huggingface.co/example/model/resolve/main/model.gguf']
          }
        }
      }),
    /model\.gguf has no usable pinned manifest URL/
  )
})

test('real mobile models all resolve to pinned integration URLs', () => {
  const resolved = resolvePinnedManifest(mobileManifest, integrationManifest)

  for (const models of Object.values(resolved)) {
    for (const model of models) {
      assert.equal(model.url, integrationManifest.models[model.name].urls[0])
      assert.doesNotMatch(model.url, /\/resolve\/(?:main|master)\//)
    }
  }
})

test('buildScript embeds the resolved manifest', () => {
  const encoded = Buffer.from('{"runExampleTest":[]}').toString('base64')
  const script = buildScript(encoded)

  assert.match(script, new RegExp(encoded))
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /adb push/)
})
