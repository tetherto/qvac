'use strict'

/**
 * Unit tests for the translation-nmtcpp model pre-stage block generator.
 * Pure parse/build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/translation-nmtcpp/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  INDICTRANS_MODEL_NAME,
  readIndicTransModels,
  buildScript,
  formatYamlBlock
} = require('../generate-prestage-block')

function withAssetsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-prestage-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function runWithStubs(script, { adbExit = 0, curlExit = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmt-prestage-shell-'))
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

test('buildScript stages the model to the Android prestage dir via adb push', () => {
  const script = buildScript([{ name: 'm.bin', url: 'https://example.com/m.bin?sig=x' }])
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /stage "m\.bin" "https:\/\/example\.com\/m\.bin\?sig=x"/)
  assert.match(script, /adb push/)
  assert.doesNotMatch(script, /pymobiledevice3/)
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

test('buildScript ios backend uses pymobiledevice3 apps push into Documents', () => {
  const script = buildScript([{ name: 'm.bin', url: 'https://example.com/m.bin?sig=x' }], 'ios')
  assert.match(script, /stage "m\.bin" "https:\/\/example\.com\/m\.bin\?sig=x"/)
  assert.match(script, /pymobiledevice3 apps push/)
  assert.match(script, /Documents\/\$NAME/)
  assert.match(script, /Documents\/\$NAME\.size/)
  assert.match(script, /unset SUDO_UID SUDO_GID/)
  assert.match(script, /not found during afc operation\|failed to perform afc operation/)
  assert.match(script, /pymobiledevice3==10\.3\.1/)
  assert.match(script, /device will use network fallback/)
  assert.match(script, /\.size/)
  assert.doesNotMatch(script, /adb push/)
  assert.doesNotMatch(script, /PRESTAGE_DIR=\/data\/local\/tmp/)
  assert.doesNotMatch(script, /FATAL/)
  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('buildScript rejects unknown platforms', () => {
  assert.throws(() => buildScript([], 'windows'), /unknown platform/)
})

test('formatYamlBlock emits a literal block with every shell line indented', () => {
  assert.equal(formatYamlBlock('set -e\necho ok'), '|\n  set -e\n  echo ok\n')
})
