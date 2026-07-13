'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  benchmarkModelsByTest,
  resolvePinnedManifest,
  buildScript
} = require('../generate-prestage-block')
const {
  matrix,
  modelFileName,
  runFunctionName,
  workflowBatches
} = require('../../test/integration/_benchmark-matrix')
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
        ...integrationManifest.models,
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
    () => resolvePinnedManifest(mobile, { models: integrationManifest.models }),
    /model\.gguf has no usable pinned manifest URL/
  )
  assert.throws(
    () =>
      resolvePinnedManifest(mobile, {
        models: {
          ...integrationManifest.models,
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

test('every benchmark model derived from the matrix is fully pinned', () => {
  const modelNames = new Set(matrix().map((cell) => modelFileName(cell.size, cell.quant)))

  assert.equal(modelNames.size, 10)
  for (const name of modelNames) {
    const entry = integrationManifest.models[name]
    assert.ok(entry, `${name} is present in the integration manifest`)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `${name} has a byte pin`)
    assert.ok(Array.isArray(entry.urls) && entry.urls.length > 0, `${name} has a URL`)
    for (const url of entry.urls) {
      assert.match(url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//)
    }
  }
})

test('every generated benchmark grep name maps to its matrix model', () => {
  const benchmarkModels = benchmarkModelsByTest()

  assert.equal(Object.keys(benchmarkModels).length, matrix().length)
  for (const cell of matrix()) {
    assert.deepEqual(benchmarkModels[runFunctionName(cell)], [
      { name: modelFileName(cell.size, cell.quant) }
    ])
  }
  for (const batch of workflowBatches()) {
    for (const group of batch.groups) {
      assert.ok(benchmarkModels[group.grep], `${group.grep} has a pre-stage mapping`)
    }
  }
})

test('buildScript embeds the resolved manifest', () => {
  const encoded = Buffer.from('{"runExampleTest":[]}').toString('base64')
  const script = buildScript(encoded)

  assert.match(script, new RegExp(encoded))
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /missing benchmark mapping/)
  assert.match(script, /adb push/)
})
