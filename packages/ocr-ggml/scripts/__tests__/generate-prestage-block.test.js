'use strict'

/**
 * Unit tests for the ocr-ggml model pre-stage block generator.
 * Pure parse/build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/ocr-ggml/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MODEL_KEYS, readModels, buildScript } = require('../generate-prestage-block')

function withAssetsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrggml-prestage-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('readModels maps every presigned URL key to its on-device filename', () => {
  withAssetsDir((dir) => {
    const config = { generatedAt: 'now' }
    for (const { key } of MODEL_KEYS) config[key] = `https://s3.example.com/${key}?sig=x`
    fs.writeFileSync(path.join(dir, 'ocr-ggml-model-urls.json'), JSON.stringify(config))

    const models = readModels(dir)
    assert.equal(models.length, MODEL_KEYS.length)
    assert.deepEqual(models.map((m) => m.name).sort(), [
      'craft_mlt_25k.gguf',
      'crnn_mobilenet_v3_small.gguf',
      'db_mobilenet_v3_large.gguf',
      'latin_g2.gguf'
    ])
  })
})

test('readModels skips missing/non-https keys and returns [] without config', () => {
  withAssetsDir((dir) => {
    assert.deepEqual(readModels(dir), [])
    fs.writeFileSync(
      path.join(dir, 'ocr-ggml-model-urls.json'),
      JSON.stringify({ craft_mlt_25k_url: 'https://ok/craft.gguf', latin_g2_url: 'ftp://nope' })
    )
    const models = readModels(dir)
    assert.deepEqual(
      models.map((m) => m.name),
      ['craft_mlt_25k.gguf']
    )
  })
})

test('buildScript stages every model to the prestage dir via adb push', () => {
  const script = buildScript([{ name: 'a.gguf', url: 'https://example.com/a.gguf?sig=x' }])
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /stage "a\.gguf" "https:\/\/example\.com\/a\.gguf\?sig=x"/)
  assert.match(script, /adb push/)
  assert.match(script, /\[prestage\] done/)
})
