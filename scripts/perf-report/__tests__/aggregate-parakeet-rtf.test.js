'use strict'

/**
 * Unit tests for the parakeet perf-report normalizers in
 * scripts/perf-report/aggregate-parakeet-rtf.js.
 *
 * Covers the reporting behaviours:
 *   1. CPU-only rows must not be attributed a GPU model.
 *   2. GPU rows keep the probed GPU model.
 *   3. Mobile rows derive RTF from wall/audio when real_time_factor is null,
 *      so Android/iOS rows are populated instead of rendering all n/a.
 *   4. Avg/peak/reclaimed memory is surfaced from summary.memory (desktop) and
 *      aggregated across run/teardown entries (mobile); the mobile peak is
 *      floored at the recorded post-activation footprint, and the metrics are
 *      rendered as columns in both the markdown and HTML tables.
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
  normalizeMobileRecords,
  renderMarkdown,
  renderHtml
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
    summary: {
      rtf: { mean: 0.005, p50: 0.005, p95: 0.006, stddev: 0.0002 },
      wallMs: { mean: 99 },
      memory: {
        avgRssMb: 812.4,
        peakRssMb: 905.7,
        reclaimedMb: 512.3,
        rssAfterLoadMb: 800,
        rssAfterUnloadMb: 288
      }
    }
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

test('mobile [sortformer-streaming] label maps to model sortformer-streaming, not sortformer', () => {
  // Guards the alternation ordering in mobileModelType(): `sortformer-streaming`
  // (v2.1) must be matched before `sortformer` (v1). If the order regresses, the
  // v2.1 label silently collapses onto `sortformer` and collides with v1 rows.
  const report = {
    addon: 'parakeet',
    addon_type: 'parakeet',
    addonVersion: '0.9.1',
    device: { name: 'Apple iPhone 16 Pro', platform: 'ios' },
    results: [
      {
        test: '[sortformer-streaming] [q8_0] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.02, wall_time_ms: 400, audio_duration_ms: 20000 }
      }
    ]
  }
  const records = normalizeMobileRecords(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  assert.equal(row.model, 'sortformer-streaming')
  assert.equal(row.quant, 'q8_0')
  assert.equal(row.gpu, 'cpu')
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

test('desktop record surfaces avg/peak/reclaimed memory from summary.memory', () => {
  const record = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  assert.equal(record.avgRssMb, 812.4)
  assert.equal(record.peakRssMb, 905.7)
  assert.equal(record.reclaimedMb, 512.3)
})

test('desktop record reports NaN memory when summary.memory is absent', () => {
  const report = desktopReport(false)
  delete report.summary.memory
  const record = normalizeDesktopRecord(report, 'rtf-benchmark-win32-x64-tdt-q8_0-cpu.json')
  assert.ok(Number.isNaN(record.avgRssMb))
  assert.ok(Number.isNaN(record.peakRssMb))
  assert.ok(Number.isNaN(record.reclaimedMb))
})

test('mobile records aggregate memory across run and teardown entries', () => {
  const report = {
    addon: 'parakeet',
    addon_type: 'parakeet',
    addonVersion: '0.9.1',
    device: { name: 'Apple iPhone 16 Pro', platform: 'ios' },
    results: [
      {
        test: '[tdt] [q8_0] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.05, wall_time_ms: 1000, avg_rss_mb: 800, peak_rss_mb: 880 }
      },
      {
        test: '[tdt] [q8_0] [CPU] mobile-perf run 2',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.06, wall_time_ms: 1100, avg_rss_mb: 820, peak_rss_mb: 900 }
      },
      {
        test: '[tdt] [q8_0] [CPU] mobile-perf teardown',
        execution_provider: 'cpu',
        metrics: { real_time_factor: null, reclaimed_mb: 512 }
      }
    ]
  }
  const records = normalizeMobileRecords(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  assert.equal(row.model, 'tdt')
  assert.equal(row.quant, 'q8_0')
  assert.equal(row.avgRssMb, 810)
  assert.equal(row.peakRssMb, 900)
  assert.equal(row.reclaimedMb, 512)
})

test('markdown table includes the memory columns and rounded values', () => {
  const record = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  const markdown = renderMarkdown([record])
  assert.ok(markdown.includes('Avg RSS (MB)'))
  assert.ok(markdown.includes('Peak RSS (MB)'))
  assert.ok(markdown.includes('Reclaimed (MB)'))
  assert.ok(markdown.includes('| 906 |'), 'peak RSS should be rounded to 906 in the table')
})

test('html table includes the memory columns and rounded values', () => {
  const record = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  const html = renderHtml([record])
  assert.ok(html.includes('<th>Avg RSS (MB)</th>'))
  assert.ok(html.includes('<th>Peak RSS (MB)</th>'))
  assert.ok(html.includes('<th>Reclaimed (MB)</th>'))
  // Guards against the header/cell lists silently desyncing on future edits.
  assert.ok(html.includes('<td>906</td>'), 'peak RSS should be rounded to 906 in a table cell')
  assert.ok(html.includes('<td>812</td>'), 'avg RSS should be rounded to 812 in a table cell')
})

test('mobile peak is floored at the recorded post-activation footprint', () => {
  const report = {
    addon: 'parakeet',
    addon_type: 'parakeet',
    addonVersion: '0.9.1',
    device: { name: 'Apple iPhone 16 Pro', platform: 'ios' },
    results: [
      {
        test: '[tdt] [q8_0] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.05, wall_time_ms: 1000, avg_rss_mb: 700, peak_rss_mb: 720 }
      },
      {
        test: '[tdt] [q8_0] [CPU] mobile-perf run 2',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.06, wall_time_ms: 1100, avg_rss_mb: 710, peak_rss_mb: 730 }
      },
      {
        test: '[tdt] [q8_0] [CPU] mobile-perf teardown',
        execution_provider: 'cpu',
        metrics: { real_time_factor: null, reclaimed_mb: 400, rss_after_load_mb: 800 }
      }
    ]
  }
  const records = normalizeMobileRecords(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  // Both run peaks (720, 730) are below the 800 footprint, so the floor wins,
  // matching how the desktop path clamps peak to rssAfterLoad.
  assert.equal(row.peakRssMb, 800)
})
