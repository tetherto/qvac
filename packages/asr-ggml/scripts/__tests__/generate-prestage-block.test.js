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
  WHISPER_TEST_MODEL_NAMES,
  buildWhisperManifest,
  buildWhisperStageBlock,
  buildSelectionCode,
  buildScript
} = require('../generate-prestage-block')
const { TEST_MODELS } = require('../generate-mobile-model-manifest')

// Wrap a bare whisper stage block in the same setup preamble the real script
// emits, so it is runnable in isolation with adb/curl stubbed out.
function wrapWhisperBlock(block) {
  return `set -e\nPRESTAGE_DIR=/data/local/tmp/prestaged-models\nHOST_PRESTAGE_DIR=/tmp/prestage\nmkdir -p "$HOST_PRESTAGE_DIR"\n${block}\n`
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

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 })
}

function runCompleteScript({
  grep = '',
  manifest = {},
  curlFailMatch = '',
  adbFailMatch = ''
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-prestage-complete-'))
  const binDir = path.join(dir, 'bin')
  const tmpDir = path.join(dir, 'tmp')
  const logDir = path.join(dir, 'logs')
  fs.mkdirSync(binDir)
  fs.mkdirSync(tmpDir)
  fs.mkdirSync(logDir)
  fs.writeFileSync(path.join(tmpDir, 'qvacShardGrep.txt'), grep)
  writeExecutable(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$STUB_LOG_DIR/curl.log"
if [ -n "\${CURL_FAIL_MATCH:-}" ] && [[ "$*" == *"$CURL_FAIL_MATCH"* ]]; then
  exit 22
fi
OUTPUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      OUTPUT="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf 'model-data' > "$OUTPUT"
`
  )
  writeExecutable(
    path.join(binDir, 'adb'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$STUB_LOG_DIR/adb.log"
if [ "$1" = "push" ] && [ -n "\${ADB_FAIL_MATCH:-}" ] && [[ "$2" == *"$ADB_FAIL_MATCH"* ]]; then
  exit 1
fi
exit 0
`
  )

  const manifestB64 = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64')
  const result = childProcess.spawnSync('bash', ['-c', buildScript(manifestB64)], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      QVAC_PRESTAGE_TMP_DIR: tmpDir,
      STUB_LOG_DIR: logDir,
      CURL_FAIL_MATCH: curlFailMatch,
      ADB_FAIL_MATCH: adbFailMatch
    },
    encoding: 'utf8'
  })
  const readLog = (name) => {
    const logPath = path.join(logDir, name)
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  }
  const outcome = {
    ...result,
    curlLog: readLog('curl.log'),
    adbLog: readLog('adb.log')
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return outcome
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

test('Whisper manifest selects only the models required by each test runner', () => {
  const manifest = buildWhisperManifest()

  assert.deepEqual(Object.keys(manifest), Object.keys(WHISPER_TEST_MODEL_NAMES))
  assert.deepEqual(
    manifest.runMobilePerfTinyCpuTest.map((model) => model.name),
    ['ggml-tiny.bin']
  )
  assert.deepEqual(
    manifest.runMobilePerfSweepGpuTest.map((model) => model.name),
    [
      'ggml-base-q5_1.bin',
      'ggml-base-q8_0.bin',
      'ggml-small-q5_1.bin',
      'ggml-small-q8_0.bin'
    ]
  )
  assert.deepEqual(manifest.runLiveStreamSimulationTest, [])
})

test('Parakeet manifest makes model-free runners explicit and stages validation models', () => {
  assert.deepEqual(TEST_MODELS.runParakeetCorruptedModelTest, [])
  assert.deepEqual(TEST_MODELS.runParakeetSortformerStreamingAliasTest, [])
  assert.deepEqual(
    TEST_MODELS.runParakeetModelFileValidationTest.map((model) => model.name),
    ['parakeet-tdt-0.6b-v3.q4_0.gguf']
  )
})

test('buildWhisperStageBlock stages every model with a .size sidecar and degrades gracefully', () => {
  const block = buildWhisperStageBlock([
    { name: 'a.bin', url: 'https://example.com/a.bin' },
    { name: 'b.bin', url: 'https://example.com/b.bin' }
  ])
  assert.match(block, /stage "a\.bin" "https:\/\/example\.com\/a\.bin"/)
  assert.match(block, /stage "b\.bin" "https:\/\/example\.com\/b\.bin"/)
  assert.match(block, /adb push/)
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

test('buildScript selects Parakeet and Whisper models from the explicit shard grep', () => {
  const script = buildScript('QkFTRTY0')
  const selectionCode = buildSelectionCode()
  // Parakeet (fail-hard, manifest-driven).
  assert.ok(script.startsWith('set -euo pipefail\n'))
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /base64 -d > "\$TMP_ROOT\/model-manifest\.json"/)
  assert.match(script, /base64 -d > "\$TMP_ROOT\/whisper-manifest\.json"/)
  assert.match(script, /cat "\$TMP_ROOT\/qvacShardGrep\.txt"/)
  assert.doesNotMatch(script, /wdio\.config\.devicefarm\.js/)
  assert.match(selectionCode, /missing model mapping for runner/)
  assert.match(selectionCode, /invalid .* model mapping for runner/)
  assert.match(selectionCode, /seen\[kind\]\.get\(model\.name\)/)
  assert.match(script, /parakeet-prestage-list\.tsv/)
  assert.match(script, /whisper-prestage-list\.tsv/)
  assert.match(script, /adb shell test -s/)
  assert.match(script, /FATAL/)
  // Whisper (graceful).
  assert.match(script, /stage "\$NAME" "\$URL"/)
  assert.match(script, /device will use network fallback/)
  assert.match(script, /\[prestage\] done/)

  const syntax = childProcess.spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('complete prestage script deduplicates selected Parakeet models', () => {
  const model = { name: 'shared.gguf', url: 'https://example.com/shared.gguf' }
  const result = runCompleteScript({
    grep: 'runParakeetOneTest|runParakeetTwoTest',
    manifest: {
      runParakeetOneTest: [model],
      runParakeetTwoTest: [model]
    }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.curlLog.trim().split('\n').length, 1)
  assert.match(result.stderr, /1 parakeet \+ 0 whisper model\(s\) for 2 test\(s\)/)
})

test('complete prestage script accepts an explicitly model-free runner', () => {
  const result = runCompleteScript({
    grep: 'runParakeetModelFreeTest',
    manifest: { runParakeetModelFreeTest: [] }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.curlLog, '')
  assert.match(result.stderr, /0 parakeet \+ 0 whisper model\(s\) for 1 test\(s\)/)
})

test('complete prestage script rejects missing grep and unknown mappings', () => {
  const missingGrep = runCompleteScript()
  assert.notEqual(missingGrep.status, 0)
  assert.match(missingGrep.stdout, /FATAL: shard grep is required/)

  const unknownMapping = runCompleteScript({ grep: 'runRenamedParakeetTest' })
  assert.notEqual(unknownMapping.status, 0)
  assert.match(unknownMapping.stderr, /missing model mapping for runner: runRenamedParakeetTest/)
})

test('complete prestage script rejects malformed manifest entries', () => {
  const result = runCompleteScript({
    grep: 'runMalformedParakeetTest',
    manifest: {
      runMalformedParakeetTest: [{ name: 'broken.gguf' }]
    }
  })

  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr,
    /invalid parakeet model mapping for runner runMalformedParakeetTest at index 0/
  )
})

test('complete prestage script keeps Parakeet staging fail-hard', () => {
  const result = runCompleteScript({
    grep: 'runRequiredParakeetTest',
    manifest: {
      runRequiredParakeetTest: [
        { name: 'required.gguf', url: 'https://example.com/required.gguf' }
      ]
    },
    curlFailMatch: 'required.gguf'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.curlLog, /required\.gguf/)
})

for (const fallback of [
  {
    name: 'download failure',
    curlFailMatch: 'ggml-tiny.bin',
    expected: /host download failed for ggml-tiny\.bin/
  },
  {
    name: 'model push failure',
    adbFailMatch: 'ggml-tiny.bin',
    expected: /adb push failed for ggml-tiny\.bin/
  },
  {
    name: 'size sidecar push failure',
    adbFailMatch: 'ggml-tiny.bin.size',
    expected: /size metadata push failed for ggml-tiny\.bin/
  }
]) {
  test(`complete prestage script preserves Whisper fallback after ${fallback.name}`, () => {
    const result = runCompleteScript({
      grep: 'runMobilePerfTinyCpuTest',
      curlFailMatch: fallback.curlFailMatch,
      adbFailMatch: fallback.adbFailMatch
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, fallback.expected)
    assert.match(result.stdout, /device will use network fallback/)
  })
}
