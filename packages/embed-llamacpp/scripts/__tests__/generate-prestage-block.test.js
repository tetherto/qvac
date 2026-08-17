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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

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

test('PRESTAGE_URL_MAP overrides pull from the US bucket and bypass the HF-shape check', () => {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'embed-prestage-')), 'map.json')
  const usUrl = 'https://tether-ai-dev-us.s3.us-west-2.amazonaws.com/x/gte-large_fp16.gguf?sig=abc'
  fs.writeFileSync(mapPath, JSON.stringify({ 'gte-large_fp16.gguf': usUrl }))
  const prev = process.env.PRESTAGE_URL_MAP
  process.env.PRESTAGE_URL_MAP = mapPath
  try {
    const models = modelsFromManifest(SAMPLE)
    const gte = models.find((m) => m.name === 'gte-large_fp16.gguf')
    assert.equal(gte.url, usUrl)
    // The pinned HF URL is retained as an on-device fallback.
    assert.match(gte.fallback, /^https:\/\/huggingface\.co\//)
    // Un-overridden models still resolve from their pinned HF URL (no fallback).
    const gemma = models.find((m) => m.name === 'embeddinggemma-300M-Q8_0.gguf')
    assert.match(gemma.url, /^https:\/\/huggingface\.co\//)
    assert.equal(gemma.fallback, undefined)
  } finally {
    if (prev === undefined) delete process.env.PRESTAGE_URL_MAP
    else process.env.PRESTAGE_URL_MAP = prev
    fs.rmSync(path.dirname(mapPath), { recursive: true, force: true })
  }
})

test('buildScript stages every model to the Android prestage dir', () => {
  const script = buildScript([
    { name: 'a.gguf', url: 'https://example.com/a.gguf' },
    { name: 'b.gguf', url: 'https://example.com/b.gguf' }
  ])
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /stage "a\.gguf" "https:\/\/example\.com\/a\.gguf"/)
  assert.match(script, /stage "b\.gguf" "https:\/\/example\.com\/b\.gguf"/)
  assert.match(script, /adb push/)
  assert.doesNotMatch(script, /pymobiledevice3/)
  assert.match(script, /\[prestage\] done/)
})

test('buildScript ios backend uses pymobiledevice3 apps push into Documents', () => {
  const script = buildScript([{ name: 'a.gguf', url: 'https://example.com/a.gguf' }], 'ios')
  assert.match(script, /stage "a\.gguf" "https:\/\/example\.com\/a\.gguf"/)
  assert.match(script, /pymobiledevice3 apps push/)
  assert.match(script, /Documents\/\$NAME/)
  assert.match(script, /unset SUDO_UID SUDO_GID/)
  assert.match(script, /not found during afc operation\|failed to perform afc operation/)
  assert.match(script, /pymobiledevice3==10\.3\.1/)
  assert.doesNotMatch(script, /adb push/)
  assert.doesNotMatch(script, /PRESTAGE_DIR=\/data\/local\/tmp/)
})

test('buildScript rejects unknown platforms', () => {
  assert.throws(() => buildScript([], 'windows'), /unknown platform/)
})

test('buildScript wires a fallback URL into the stage call and curl fall-through', () => {
  const script = buildScript([
    { name: 'a.gguf', url: 'https://us/a?sig=1', fallback: 'https://hf/a' }
  ])
  assert.match(script, /stage "a\.gguf" "https:\/\/us\/a\?sig=1" "https:\/\/hf\/a"/)
  assert.match(script, /NAME="\$1"; URL="\$2"; FALLBACK="\$3"/)
  assert.match(script, /\[ -n "\$FALLBACK" \] && curl/)
})

test('real integration manifest drives the complete pre-stage set', () => {
  const models = modelsFromManifest(realManifest)
  assert.equal(models.length, Object.keys(realManifest.models).length)
  assert.ok(models.some((model) => model.name.includes('embeddinggemma')))
})
