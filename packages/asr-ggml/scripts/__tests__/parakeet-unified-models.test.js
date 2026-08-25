'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const path = require('node:path')
const test = require('node:test')
const { ALL_TYPES, MODELS, selectVariants } = require('../download-parakeet-models.js')
const { MODELS: MOBILE_MODELS, TEST_MODELS } = require('../generate-mobile-model-manifest.js')
const { parseMatrixConfig } = require('../run-rtf-benchmark-matrix.js')

const SCRIPTS_DIR = path.resolve(__dirname, '..')
const UNIFIED_PREFIX = 'qvac_models_compiled/ggml/parakeet/2026-08-13'
const UNIFIED_FILES = [
  'parakeet-unified-en-0.6b.f16.gguf',
  'parakeet-unified-en-0.6b.q8_0.gguf',
  'parakeet-unified-en-0.6b.q4_0.gguf'
]

function runHelp(scriptName) {
  return childProcess.spawnSync('bash', [path.join(SCRIPTS_DIR, scriptName), '--help'], {
    encoding: 'utf8'
  })
}

test('registry downloader exposes every unified quant', () => {
  assert.ok(ALL_TYPES.includes('unified'))
  assert.deepEqual(
    ['f16', 'q8_0', 'q4_0'].map((quant) => MODELS.unified[quant].filename),
    UNIFIED_FILES
  )
  for (const variant of selectVariants('unified', 'q8_0')) {
    assert.equal(variant.registryPath, `${UNIFIED_PREFIX}/${variant.filename}`)
  }
})

test('conversion and Hugging Face download CLIs accept unified', () => {
  for (const scriptName of ['convert-nemo.sh', 'parakeet-download-models.sh']) {
    const result = runHelp(scriptName)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /unified/)
  }
})

test('duplex streaming stages only the TDT model', () => {
  assert.deepEqual(
    TEST_MODELS.runParakeetDuplexStreamingTest.map((entry) => entry.name),
    [MOBILE_MODELS.tdtQ4.name]
  )
})

test('default desktop benchmark matrix excludes unified', () => {
  assert.equal(
    parseMatrixConfig().some((entry) => entry.modelType === 'unified'),
    false
  )
})
