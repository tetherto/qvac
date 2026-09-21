'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const path = require('node:path')
const test = require('node:test')
const { ALL_TYPES, MODELS, selectVariants } = require('../download-parakeet-models.js')
const { MODELS: MOBILE_MODELS, TEST_MODELS } = require('../generate-mobile-model-manifest.js')
const { addUnifiedCoverage } = require('../run-rtf-benchmark-matrix.js')

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

test('mobile model mappings stage unified CPU and GPU quant sweeps', () => {
  assert.deepEqual(
    [MOBILE_MODELS.unifiedF16, MOBILE_MODELS.unifiedQ8, MOBILE_MODELS.unifiedQ4].map(
      (entry) => entry.name
    ),
    UNIFIED_FILES
  )
  for (const runner of [
    'runParakeetMobilePerfUnifiedCpuTest',
    'runParakeetMobilePerfUnifiedGpuTest'
  ]) {
    assert.deepEqual(
      TEST_MODELS[runner].map((entry) => entry.name).sort(),
      UNIFIED_FILES.slice().sort()
    )
  }
})

test('duplex streaming stages TDT and Unified models', () => {
  assert.deepEqual(
    TEST_MODELS.runParakeetDuplexStreamingTest.map((entry) => entry.name),
    [MOBILE_MODELS.tdtQ4.name, MOBILE_MODELS.unifiedQ4.name]
  )
})

test('desktop benchmark coverage mirrors every TDT quant and GPU policy', () => {
  const entries = [
    { engine: 'parakeet', modelType: 'tdt', quant: 'f16', useGPU: false },
    { engine: 'parakeet', modelType: 'tdt', quant: 'q8_0', useGPU: true },
    { engine: 'whisper', modelFile: 'ggml-base.bin', useGPU: false }
  ]
  const expanded = addUnifiedCoverage(entries)
  assert.deepEqual(
    expanded.filter((entry) => entry.modelType === 'unified'),
    [
      { engine: 'parakeet', modelType: 'unified', quant: 'f16', useGPU: false },
      { engine: 'parakeet', modelType: 'unified', quant: 'q8_0', useGPU: true }
    ]
  )
})

test('desktop benchmark coverage preserves distinct TDT configurations', () => {
  const entries = [
    {
      engine: 'parakeet',
      modelType: 'tdt',
      quant: 'q8_0',
      useGPU: false,
      maxThreads: 2
    },
    {
      engine: 'parakeet',
      modelType: 'tdt',
      quant: 'q8_0',
      useGPU: false,
      maxThreads: 4
    },
    {
      engine: 'parakeet',
      modelType: 'unified',
      quant: 'q8_0',
      useGPU: false,
      maxThreads: 2
    }
  ]

  assert.deepEqual(
    addUnifiedCoverage(entries).filter((entry) => entry.modelType === 'unified'),
    [
      entries[2],
      {
        engine: 'parakeet',
        modelType: 'unified',
        quant: 'q8_0',
        useGPU: false,
        maxThreads: 4
      }
    ]
  )
})
