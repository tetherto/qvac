'use strict'

/**
 * Unit tests for the CPU-vs-Vulkan comparison helpers in
 * scripts/perf-report/utils.js (QVAC-19942).
 *
 * Pure-function code paths only — no `gh`, no network, no fixtures on disk.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/backend-comparison.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  computeBackendComparison,
  generateBackendComparison,
  generateMarkdownReport,
  generateHtmlReport
} = require('../utils')

function metric (mean) {
  return { mean, min: mean, max: mean, std: 0, count: 1, values: [mean] }
}

// Aggregated shape with a single device that ran the same base test on BOTH
// CPU and Vulkan (the runOcrComparison dual-pass on a GPU host).
function pairedAggregated () {
  return {
    addon: 'ocr-ggml',
    generated_at: new Date().toISOString(),
    run_numbers: [1],
    devices: {
      'GPU Runner': {
        '[OCR basic] [CPU]': {
          total_time_ms: metric(200),
          detection_time_ms: metric(120),
          recognition_time_ms: metric(80)
        },
        '[OCR basic] [GPU]': {
          total_time_ms: metric(100),
          detection_time_ms: metric(60),
          recognition_time_ms: metric(40)
        }
      }
    },
    quality: {},
    device_meta: {},
    categorical: {},
    scenarios: {}
  }
}

// Aggregated shape with only CPU rows (non-GPU host / single-backend addon).
function cpuOnlyAggregated () {
  return {
    addon: 'ocr-onnx',
    generated_at: new Date().toISOString(),
    run_numbers: [1],
    devices: {
      'CPU Runner': {
        '[OCR basic] [CPU]': { total_time_ms: metric(200) }
      }
    },
    quality: {},
    device_meta: {},
    categorical: {},
    scenarios: {}
  }
}

test('computeBackendComparison pairs CPU/Vulkan rows and computes speedup', () => {
  const cmp = computeBackendComparison(pairedAggregated())
  assert.equal(cmp.hasComparison, true)

  const entry = cmp.devices['GPU Runner']['[OCR basic]']
  assert.ok(entry, 'base test paired across backends')
  assert.equal(entry.cpu.total_time_ms, 200)
  assert.equal(entry.gpu.total_time_ms, 100)
  // Speedup = CPU mean / Vulkan mean.
  assert.equal(entry.speedup.total_time_ms, 2)
  assert.equal(entry.speedup.detection_time_ms, 2)
  assert.equal(entry.speedup.recognition_time_ms, 2)
})

test('computeBackendComparison is empty when only one backend is present', () => {
  const cmp = computeBackendComparison(cpuOnlyAggregated())
  assert.equal(cmp.hasComparison, false)
  assert.deepEqual(cmp.devices, {})
})

test('computeBackendComparison skips a base test missing a total-time pair', () => {
  const agg = pairedAggregated()
  // Drop the GPU total-time so the pair is incomplete for the headline metric.
  delete agg.devices['GPU Runner']['[OCR basic] [GPU]'].total_time_ms
  const cmp = computeBackendComparison(agg)
  assert.equal(cmp.hasComparison, false)
})

test('generateBackendComparison renders a table only when a pair exists', () => {
  const md = generateBackendComparison(pairedAggregated())
  assert.match(md, /CPU \u2192 Vulkan Speedup/)
  assert.match(md, /\[OCR basic\]/)
  assert.match(md, /2\.00x/)

  assert.equal(generateBackendComparison(cpuOnlyAggregated()), '')
})

test('markdown report includes the speedup section when paired, omits it otherwise', () => {
  const withPair = generateMarkdownReport(pairedAggregated())
  assert.match(withPair, /CPU \u2192 Vulkan Speedup/)

  const withoutPair = generateMarkdownReport(cpuOnlyAggregated())
  assert.doesNotMatch(withoutPair, /CPU \u2192 Vulkan Speedup/)
})

test('html report includes the speedup section when paired, omits it otherwise', () => {
  const withPair = generateHtmlReport(pairedAggregated())
  assert.match(withPair, /Vulkan Speedup/)
  assert.match(withPair, /2\.00x/)

  const withoutPair = generateHtmlReport(cpuOnlyAggregated())
  assert.doesNotMatch(withoutPair, /Vulkan Speedup/)
})
