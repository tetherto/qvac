'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-mobile-assets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const directory of ['scripts', 'weights', 'test/images', 'test/fixtures']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true })
  }
  fs.copyFileSync(
    path.join(__dirname, '..', 'copy-mobile-test-assets.js'),
    path.join(root, 'scripts/copy-mobile-test-assets.js')
  )
  fs.writeFileSync(path.join(root, 'weights/mobilenetv3_3class_v3_fp16.gguf'), 'mobilenet')
  fs.writeFileSync(path.join(root, 'test/images/sample.png'), 'image')
  fs.writeFileSync(path.join(root, 'test/fixtures/megaloc-input.png'), 'reference image')
  fs.writeFileSync(path.join(root, 'test/fixtures/megaloc-upscale-f32.bin'), 'reference descriptor')
  for (const quant of ['f16', 'mixed']) {
    fs.writeFileSync(path.join(root, `test/fixtures/megaloc-${quant}.gguf`), quant)
  }
  return root
}

function stage(root, overrides = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/copy-mobile-test-assets.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QVAC_MEGALOC_F16_MODEL_PATH: '',
      QVAC_MEGALOC_MIXED_MODEL_PATH: '',
      ...overrides
    }
  })
}

test('mobile assets use manually converted fixtures and retain reference files', (t) => {
  const root = fixture(t)
  const result = stage(root)
  assert.equal(result.status, 0, result.stderr)
  const assets = path.join(root, 'test/mobile/testAssets')
  for (const quant of ['f16', 'mixed']) {
    assert.equal(fs.readFileSync(path.join(assets, `megaloc-${quant}.gguf.bin`), 'utf8'), quant)
  }
  assert.equal(fs.readFileSync(path.join(assets, 'megaloc-input.png'), 'utf8'), 'reference image')
  assert.equal(
    fs.readFileSync(path.join(assets, 'megaloc-upscale-f32.bin'), 'utf8'),
    'reference descriptor'
  )
  assert.equal(
    fs.readFileSync(path.join(assets, 'mobilenetv3_3class_v3_fp16.gguf.bin'), 'utf8'),
    'mobilenet'
  )
})

test('mobile assets honor explicit model paths', (t) => {
  const root = fixture(t)
  const custom = path.join(root, 'custom.gguf')
  fs.writeFileSync(custom, 'custom model')
  const result = stage(root, { QVAC_MEGALOC_F16_MODEL_PATH: custom })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    fs.readFileSync(path.join(root, 'test/mobile/testAssets/megaloc-f16.gguf.bin'), 'utf8'),
    'custom model'
  )
})

test('mobile assets reject missing models and invalid explicit paths', (t) => {
  const root = fixture(t)
  const invalid = path.join(root, 'missing.gguf')
  const overridden = stage(root, { QVAC_MEGALOC_F16_MODEL_PATH: invalid })
  assert.notEqual(overridden.status, 0)
  assert.match(overridden.stderr, /Convert the MegaLoc test models first/)
  fs.unlinkSync(path.join(root, 'test/fixtures/megaloc-mixed.gguf'))
  const missing = stage(root)
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /QVAC_MEGALOC_MIXED_MODEL_PATH/)
})
