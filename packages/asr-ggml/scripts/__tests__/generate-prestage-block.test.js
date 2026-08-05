'use strict'

/**
 * Unit tests for the ASR mobile model pre-stage block generator.
 * Pure build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/asr-ggml/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  WHISPER_MODELS,
  buildWhisperStageBlock,
  buildScript
} = require('../generate-prestage-block')

// Wrap a bare whisper stage block in the same setup preamble the real script
// emits, so it is runnable in isolation with adb/curl stubbed out.
function wrapWhisperBlock(block) {
  return `set -e\nPRESTAGE_DIR=/data/local/tmp/prestaged-models\nmkdir -p /tmp/prestage\n${block}\n`
}

function wrapIosWhisperBlock(block) {
  return `set -e\nBID=io.tether.test.qvac\nPRESTAGE_READY=1\nmkdir -p /tmp/prestage\n${block}\n`
}

function runWithStubs(script, { adbExit = 0, curlExit = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-prestage-shell-'))
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

test('WHISPER_MODELS covers the full mobile set: functional + perf-sweep quants', () => {
  const names = WHISPER_MODELS.map((m) => m.name)
  // tiny + VAD (functional) plus the base/small q5_1/q8_0 perf-sweep quants.
  assert.deepEqual(names, [
    'ggml-tiny.bin',
    'ggml-silero-v5.1.2.bin',
    'ggml-base-q5_1.bin',
    'ggml-base-q8_0.bin',
    'ggml-small-q5_1.bin',
    'ggml-small-q8_0.bin'
  ])
  for (const m of WHISPER_MODELS) {
    assert.match(m.url, /^https:\/\/huggingface\.co\//)
    assert.ok(m.url.endsWith(m.name))
  }
})

test('buildWhisperStageBlock stages every model with a .size sidecar and degrades gracefully', () => {
  const block = buildWhisperStageBlock([
    { name: 'a.bin', url: 'https://example.com/a.bin' },
    { name: 'b.bin', url: 'https://example.com/b.bin' }
  ])
  assert.match(block, /stage "a\.bin" "https:\/\/example\.com\/a\.bin"/)
  assert.match(block, /stage "b\.bin" "https:\/\/example\.com\/b\.bin"/)
  assert.match(block, /adb push/)
  assert.doesNotMatch(block, /pymobiledevice3/)
  assert.match(block, /wc -c/)
  assert.match(block, /\.size/)
  assert.match(block, /device will use network fallback/)
  // Whisper never fails the run — parakeet owns the fail-hard path.
  assert.doesNotMatch(block, /FATAL/)

  const script = wrapWhisperBlock(block)
  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  const failedDownload = runWithStubs(script, { curlExit: 22 })
  assert.equal(failedDownload.status, 0, failedDownload.stderr)
  assert.match(failedDownload.stdout, /device will use network fallback/)
})

test('buildWhisperStageBlock ios backend pushes sidecars into Documents and degrades gracefully', () => {
  const block = buildWhisperStageBlock(
    [
      { name: 'a.bin', url: 'https://example.com/a.bin' },
      { name: 'b.bin', url: 'https://example.com/b.bin' }
    ],
    'ios'
  )
  assert.match(block, /stage "a\.bin" "https:\/\/example\.com\/a\.bin"/)
  assert.match(block, /stage "b\.bin" "https:\/\/example\.com\/b\.bin"/)
  assert.match(block, /pymobiledevice3 apps push/)
  assert.match(block, /Documents\/\$NAME/)
  assert.match(block, /Documents\/\$NAME\.size/)
  assert.match(block, /wc -c/)
  assert.match(block, /\.size/)
  assert.match(block, /device will use network fallback/)
  assert.doesNotMatch(block, /adb push/)
  assert.doesNotMatch(block, /FATAL/)

  const script = wrapIosWhisperBlock(block)
  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('buildWhisperStageBlock rejects unknown platforms', () => {
  assert.throws(() => buildWhisperStageBlock([], 'windows'), /unknown platform/)
})

test('buildScript emits the Android parakeet manifest block and the whisper block together', () => {
  const script = buildScript('QkFTRTY0')
  // Parakeet (fail-hard, manifest-driven).
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /base64 -d > \/tmp\/model-manifest\.json/)
  assert.match(script, /adb shell test -s/)
  assert.match(script, /FATAL/)
  assert.doesNotMatch(script, /pymobiledevice3/)
  // Whisper (graceful).
  assert.match(script, /stage "ggml-tiny\.bin"/)
  assert.match(script, /stage "ggml-silero-v5\.1\.2\.bin"/)
  assert.match(script, /stage "ggml-base-q5_1\.bin"/)
  assert.match(script, /stage "ggml-base-q8_0\.bin"/)
  assert.match(script, /stage "ggml-small-q5_1\.bin"/)
  assert.match(script, /stage "ggml-small-q8_0\.bin"/)
  assert.match(script, /\[prestage\] done/)

  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('buildScript ios backend pushes parakeet into Documents and keeps whisper graceful', () => {
  const script = buildScript('QkFTRTY0', 'ios')
  // Parakeet (fail-hard, manifest-driven).
  assert.match(script, /base64 -d > \/tmp\/model-manifest\.json/)
  assert.match(script, /pymobiledevice3 apps push/)
  assert.match(script, /Documents\/\$NAME/)
  assert.match(script, /FATAL: push of \$NAME failed/)
  assert.match(script, /FATAL: pymobiledevice3 unavailable for parakeet pre-stage/)
  assert.match(script, /unset SUDO_UID SUDO_GID/)
  assert.match(script, /traceback\|afcexception\|failed with status/)
  assert.doesNotMatch(script, /adb push/)
  assert.doesNotMatch(script, /PRESTAGE_DIR=\/data\/local\/tmp/)
  // Whisper (graceful).
  assert.match(script, /stage "ggml-tiny\.bin"/)
  assert.match(script, /stage "ggml-silero-v5\.1\.2\.bin"/)
  assert.match(script, /Documents\/\$NAME\.size/)
  assert.match(script, /device will use network fallback/)
  assert.match(script, /\[prestage\] done/)

  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('buildScript rejects unknown platforms', () => {
  assert.throws(() => buildScript('QkFTRTY0', 'windows'), /unknown platform/)
})
