'use strict'

/**
 * Unit tests for the pure matrix/label/env helpers in
 * scripts/run-rtf-benchmark-matrix.js.
 *
 * Pure code paths only — requiring the module does not spawn a benchmark
 * (main() is guarded by require.main === module).
 *
 * Run locally:
 *   node --test scripts/__tests__/run-rtf-benchmark-matrix.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_DIT_VARIANT,
  DEFAULT_MATRIX,
  parseMatrixConfig,
  normalizeBoolean,
  buildLabel,
  buildEnv,
  getEntryTimeoutMs
} = require('../run-rtf-benchmark-matrix')

const MATRIX_ENV = 'QVAC_AUDIOGEN_GGML_BENCHMARK_MATRIX_JSON'
const TIMEOUT_ENV = 'QVAC_AUDIOGEN_GGML_BENCHMARK_ENTRY_TIMEOUT_MS'

function withEnv(overrides, run) {
  const saved = new Map()
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('parseMatrixConfig falls back to a single turbo-q4 CPU entry', () => {
  withEnv({ [MATRIX_ENV]: undefined }, () => {
    assert.deepEqual(parseMatrixConfig(), DEFAULT_MATRIX)
    assert.equal(DEFAULT_MATRIX[0].ditVariant, DEFAULT_DIT_VARIANT)
    assert.equal(DEFAULT_MATRIX[0].useGPU, false)
  })
})

test('parseMatrixConfig reads a JSON array from the environment', () => {
  const matrix = [
    { ditVariant: 'turbo-q8', useGPU: true },
    { ditVariant: 'sft', useGPU: false }
  ]
  withEnv({ [MATRIX_ENV]: JSON.stringify(matrix) }, () => {
    assert.deepEqual(parseMatrixConfig(), matrix)
  })
})

test('parseMatrixConfig rejects a non-array or empty matrix', () => {
  withEnv({ [MATRIX_ENV]: '{"ditVariant":"sft"}' }, () => {
    assert.throws(() => parseMatrixConfig(), /must be a non-empty JSON array/)
  })
  withEnv({ [MATRIX_ENV]: '[]' }, () => {
    assert.throws(() => parseMatrixConfig(), /must be a non-empty JSON array/)
  })
})

test('normalizeBoolean accepts the JSON and string spellings CI produces', () => {
  assert.equal(normalizeBoolean(true), true)
  assert.equal(normalizeBoolean('true'), true)
  assert.equal(normalizeBoolean('1'), true)
  assert.equal(normalizeBoolean(false), false)
  assert.equal(normalizeBoolean('false'), false)
  assert.equal(normalizeBoolean(undefined), false)
})

test('buildLabel encodes the position, variant and execution provider', () => {
  assert.equal(buildLabel({ ditVariant: 'turbo-q4', useGPU: false }, 0), '1-turbo-q4-cpu')
  assert.equal(buildLabel({ ditVariant: 'sft', useGPU: true }, 2), '3-sft-gpu')
})

test('buildLabel defaults the variant and honours an explicit label', () => {
  assert.equal(buildLabel({ useGPU: true }, 0), `1-${DEFAULT_DIT_VARIANT}-gpu`)
  assert.equal(buildLabel({ ditVariant: 'sft', label: 'custom' }, 4), 'custom')
})

test('buildEnv sets the per-entry benchmark variables', () => {
  withEnv({ [MATRIX_ENV]: undefined }, () => {
    const env = buildEnv({ ditVariant: 'turbo-q8', useGPU: true, backendHint: 'vulkan' }, 1)

    assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_DIT_VARIANT, 'turbo-q8')
    assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_USE_GPU, 'true')
    assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND, 'vulkan')
    assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_LABEL, '2-turbo-q8-gpu')
  })
})

test('buildEnv omits optional overrides that the entry does not set', () => {
  const env = buildEnv({ ditVariant: 'turbo-q4', useGPU: false }, 0)

  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_RUNS, undefined)
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_WARMUP_RUNS, undefined)
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_DURATION_S, undefined)
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_RTF_UPPER_BOUND, undefined)
})

test('buildEnv forwards every optional override as a string', () => {
  const env = buildEnv(
    {
      ditVariant: 'sft',
      useGPU: false,
      numWarmup: 0,
      numRuns: 5,
      durationS: 30,
      inferenceSteps: 50,
      shift: 1,
      numThreads: 8,
      rtfUpperBound: 4.5
    },
    0
  )

  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_WARMUP_RUNS, '0')
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_RUNS, '5')
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_DURATION_S, '30')
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_INFERENCE_STEPS, '50')
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_SHIFT, '1')
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_NUM_THREADS, '8')
  assert.equal(env.QVAC_AUDIOGEN_GGML_BENCHMARK_RTF_UPPER_BOUND, '4.5')
})

test('buildEnv lets an entry field win over the ambient matrix-wide default', () => {
  withEnv(
    {
      QVAC_AUDIOGEN_GGML_BENCHMARK_DEVICE: 'ambient-device',
      QVAC_AUDIOGEN_GGML_BENCHMARK_RUNNER: 'ambient-runner',
      QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND: 'cpu'
    },
    () => {
      const inheritedEnv = buildEnv({ ditVariant: 'turbo-q4', useGPU: false }, 0)
      assert.equal(inheritedEnv.QVAC_AUDIOGEN_GGML_BENCHMARK_DEVICE, 'ambient-device')
      assert.equal(inheritedEnv.QVAC_AUDIOGEN_GGML_BENCHMARK_RUNNER, 'ambient-runner')
      assert.equal(inheritedEnv.QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND, 'cpu')

      const overriddenEnv = buildEnv(
        {
          ditVariant: 'turbo-q4',
          useGPU: true,
          deviceLabel: 'entry-device',
          backendHint: 'vulkan'
        },
        0
      )
      assert.equal(overriddenEnv.QVAC_AUDIOGEN_GGML_BENCHMARK_DEVICE, 'entry-device')
      assert.equal(overriddenEnv.QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND, 'vulkan')
      assert.equal(overriddenEnv.QVAC_AUDIOGEN_GGML_BENCHMARK_RUNNER, 'ambient-runner')
    }
  )
})

test('buildEnv forwards the GitHub correlation variables when present', () => {
  withEnv({ GITHUB_RUN_ID: '123', GITHUB_SHA: 'abc123' }, () => {
    const env = buildEnv({ ditVariant: 'turbo-q4', useGPU: false }, 0)
    assert.equal(env.GITHUB_RUN_ID, '123')
    assert.equal(env.GITHUB_SHA, 'abc123')
  })
})

test('getEntryTimeoutMs honours a positive override and ignores junk', () => {
  withEnv({ [TIMEOUT_ENV]: '60000' }, () => {
    assert.equal(getEntryTimeoutMs(), 60000)
  })
  withEnv({ [TIMEOUT_ENV]: '0' }, () => {
    assert.ok(getEntryTimeoutMs() > 0, 'a non-positive override falls back to the default')
  })
  withEnv({ [TIMEOUT_ENV]: 'soon' }, () => {
    assert.ok(getEntryTimeoutMs() > 0, 'an unparseable override falls back to the default')
  })
})
