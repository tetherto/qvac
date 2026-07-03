'use strict'

/**
 * Unit tests for the parakeet perf-report normalizers in
 * scripts/perf-report/aggregate-parakeet-rtf.js (QVAC-21618).
 *
 * Covers three reporting fixes:
 *   1. CPU-only rows must not be attributed a GPU model.
 *   2. GPU rows keep the probed GPU model.
 *   3. Mobile rows derive RTF from wall/audio when real_time_factor is null,
 *      so Android/iOS rows are populated instead of rendering all n/a.
 *
 * Pure-function code paths only — no fixtures on disk.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/aggregate-parakeet-rtf.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeDesktopRecord,
  normalizeMobileRecords
} = require('../aggregate-parakeet-rtf')

function desktopReport (useGPU) {
  return {
    platform: 'win32-x64',
    platformName: 'win32',
    addonVersion: '0.8.2',
    model: { type: 'tdt', quant: 'q8_0' },
    requested: { useGPU },
    labels: { device: 'qvac-win25-x64-gpu', backend: useGPU ? 'vulkan' : 'cpu' },
    device: { gpu: 'NVIDIA RTX 4000 SFF Ada Generation' },
    summary: { rtf: { mean: 0.005, p50: 0.005, p95: 0.006, stddev: 0.0002 }, wallMs: { mean: 99 } }
  }
}

test('CPU desktop row is not attributed a GPU model', () => {
  const record = normalizeDesktopRecord(desktopReport(false), 'rtf-benchmark-win32-x64-tdt-q8_0-cpu.json')
  assert.equal(record.gpu, 'cpu')
  assert.equal(record.gpuModel, null)
})

test('GPU desktop row keeps the probed GPU model', () => {
  const record = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  assert.equal(record.gpu, 'gpu')
  assert.equal(record.gpuModel, 'NVIDIA RTX 4000 SFF Ada Generation')
})

test('mobile RTF is derived from wall/audio when real_time_factor is null', () => {
  const report = {
    addon: 'parakeet',
    addon_type: 'parakeet',
    addonVersion: '0.8.2',
    device: { name: 'Apple iPhone 16 Pro', platform: 'ios' },
    results: [
      {
        test: '[tdt] [q8_0] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: null, wall_time_ms: 1000, audio_duration_ms: 20000 }
      }
    ]
  }
  const records = normalizeMobileRecords(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  assert.equal(row.platformFamily, 'ios')
  // 1000ms / 20000ms = 0.05
  assert.ok(Math.abs(row.meanRtf - 0.05) < 1e-9, `expected ~0.05, got ${row.meanRtf}`)
  assert.ok(Number.isFinite(row.p95))
  assert.equal(row.gpuModel, null)
})
