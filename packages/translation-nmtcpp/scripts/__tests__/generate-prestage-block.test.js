'use strict'

/**
 * Unit tests for the translation-nmtcpp model pre-stage block generator
 * (QVAC-21799). Pure parse/build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/translation-nmtcpp/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  INDICTRANS_MODEL_NAME,
  readIndicTransModels,
  buildScript
} = require('../generate-prestage-block')

function withAssetsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-prestage-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('readIndicTransModels reads the presigned URL from indictrans-model-urls.json', () => {
  withAssetsDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'indictrans-model-urls.json'),
      JSON.stringify({ modelUrl: 'https://s3.example.com/indictrans.bin?X-Amz-Signature=abc' })
    )
    const models = readIndicTransModels(dir)
    assert.equal(models.length, 1)
    assert.equal(models[0].name, INDICTRANS_MODEL_NAME)
    assert.match(models[0].url, /^https:\/\/s3\.example\.com\/indictrans\.bin\?/)
  })
})

test('readIndicTransModels returns [] when config is missing or malformed', () => {
  withAssetsDir((dir) => {
    assert.deepEqual(readIndicTransModels(dir), [])
    fs.writeFileSync(path.join(dir, 'indictrans-model-urls.json'), '{ not json')
    assert.deepEqual(readIndicTransModels(dir), [])
    fs.writeFileSync(
      path.join(dir, 'indictrans-model-urls.json'),
      JSON.stringify({ modelUrl: 'ftp://nope' })
    )
    assert.deepEqual(readIndicTransModels(dir), [])
  })
})

test('buildScript stages the model to the prestage dir via adb push', () => {
  const script = buildScript([{ name: 'm.bin', url: 'https://example.com/m.bin?sig=x' }])
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /stage "m\.bin" "https:\/\/example\.com\/m\.bin\?sig=x"/)
  assert.match(script, /adb push/)
  assert.match(script, /\[prestage\] done/)
})
