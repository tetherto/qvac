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
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MODEL_KEYS,
  readModels,
  buildScript,
  formatYamlBlock
} = require('../generate-prestage-block')

function withAssetsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrggml-prestage-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function runWithStubs(script, { adbExit = 0, curlExit = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrggml-prestage-shell-'))
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'adb'), `#!/bin/sh\nexit ${adbExit}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'curl'), `#!/bin/sh\nexit ${curlExit}\n`, { mode: 0o755 })
  try {
    return childProcess.spawnSync('sh', ['-c', script], {
      cwd: dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8'
    })
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
  assert.match(script, /wc -c/)
  assert.match(script, /\.size/)
  assert.match(script, /device will use network fallback/)
  assert.doesNotMatch(script, /FATAL/)
  assert.match(script, /\[prestage\] done/)
  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  const failedDownload = runWithStubs(script, { curlExit: 22 })
  assert.equal(failedDownload.status, 0, failedDownload.stderr)
  assert.match(failedDownload.stdout, /device will use network fallback/)
  const failedAdb = runWithStubs(script, { adbExit: 1 })
  assert.equal(failedAdb.status, 0, failedAdb.stderr)
  assert.match(failedAdb.stdout, /adb setup failed/)
})

test('formatYamlBlock emits a literal block with every shell line indented', () => {
  assert.equal(formatYamlBlock('set -e\necho ok'), '|\n  set -e\n  echo ok\n')
})
