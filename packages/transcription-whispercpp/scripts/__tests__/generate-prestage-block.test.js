'use strict'

/**
 * Unit tests for the whisper model pre-stage block generator.
 * Pure build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/transcription-whispercpp/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MODELS, buildScript, formatYamlBlock } = require('../generate-prestage-block')

function runWithStubs(script, { adbExit = 0, curlExit = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-prestage-shell-'))
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

test('MODELS covers the full mobile set: functional + perf-sweep quants', () => {
  const names = MODELS.map((m) => m.name)
  // tiny + VAD (functional) plus the base/small q5_1/q8_0 perf-sweep quants.
  assert.deepEqual(names, [
    'ggml-tiny.bin',
    'ggml-silero-v5.1.2.bin',
    'ggml-base-q5_1.bin',
    'ggml-base-q8_0.bin',
    'ggml-small-q5_1.bin',
    'ggml-small-q8_0.bin'
  ])
  for (const m of MODELS) {
    assert.match(m.url, /^https:\/\/huggingface\.co\//)
    assert.ok(m.url.endsWith(m.name))
  }
})

test('buildScript stages every model to the prestage dir via adb push', () => {
  const script = buildScript([
    { name: 'a.bin', url: 'https://example.com/a.bin' },
    { name: 'b.bin', url: 'https://example.com/b.bin' }
  ])
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /stage "a\.bin" "https:\/\/example\.com\/a\.bin"/)
  assert.match(script, /stage "b\.bin" "https:\/\/example\.com\/b\.bin"/)
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

test('buildScript stages the real whisper model set', () => {
  const script = buildScript(MODELS)
  assert.match(script, /stage "ggml-tiny\.bin"/)
  assert.match(script, /stage "ggml-silero-v5\.1\.2\.bin"/)
  assert.match(script, /stage "ggml-base-q5_1\.bin"/)
  assert.match(script, /stage "ggml-base-q8_0\.bin"/)
  assert.match(script, /stage "ggml-small-q5_1\.bin"/)
  assert.match(script, /stage "ggml-small-q8_0\.bin"/)
})

test('formatYamlBlock emits a literal block with every shell line indented', () => {
  assert.equal(formatYamlBlock('set -e\necho ok'), '|\n  set -e\n  echo ok\n')
})
