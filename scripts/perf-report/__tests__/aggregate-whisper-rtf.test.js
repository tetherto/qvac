'use strict'

// Unit tests for the memory normalizers in aggregate-whisper-rtf.js.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeReport,
  normalizeMobileRecords,
  renderMarkdown
} = require('../aggregate-whisper-rtf')

function desktopReport (useGPU) {
  return {
    platform: 'linux-x64',
    platformName: 'linux',
    model: { name: 'ggml-tiny-q5_1.bin' },
    requested: { useGPU },
    labels: { device: 'qvac-ubuntu2404-x64-gpu', backend: useGPU ? 'vulkan' : 'cpu' },
    summary: {
      rtf: { mean: 0.1, stddev: 0.01, p50: 0.1, p95: 0.12 },
      wallMs: { mean: 500 },
      memory: {
        avgRssMb: 320.5,
        peakRssMb: 410.25,
        reclaimedMb: 180.75,
        rssAfterLoadMb: 300,
        rssAfterUnloadMb: 120
      }
    }
  }
}

test('desktop record surfaces avg/peak/reclaimed memory from summary.memory', () => {
  const record = normalizeReport(desktopReport(true), 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-gpu.json', 'desktop-ci')
  assert.equal(record.model, 'ggml-tiny-q5_1')
  assert.equal(record.avgRssMb, 320.5)
  assert.equal(record.peakRssMb, 410.25)
  assert.equal(record.reclaimedMb, 180.75)
})

test('desktop record reports NaN memory when summary.memory is absent', () => {
  const report = desktopReport(false)
  delete report.summary.memory
  const record = normalizeReport(report, 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-cpu.json', 'desktop-ci')
  assert.ok(Number.isNaN(record.avgRssMb))
  assert.ok(Number.isNaN(record.peakRssMb))
  assert.ok(Number.isNaN(record.reclaimedMb))
})

test('mobile records aggregate memory across run and teardown entries', () => {
  const report = {
    addon: 'whisper',
    addon_type: 'whisper',
    device: { name: 'Pixel 9', platform: 'android' },
    results: [
      {
        test: '[ggml-tiny] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.2, wall_time_ms: 1000, avg_rss_mb: 300, peak_rss_mb: 360 }
      },
      {
        test: '[ggml-tiny] [CPU] mobile-perf run 2',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.22, wall_time_ms: 1100, avg_rss_mb: 320, peak_rss_mb: 400 }
      },
      {
        test: '[ggml-tiny] [CPU] mobile-perf teardown',
        execution_provider: 'cpu',
        metrics: { real_time_factor: null, reclaimed_mb: 250 }
      }
    ]
  }
  const records = normalizeMobileRecords(report, '/x/Pixel_9/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  assert.equal(row.avgRssMb, 310)
  assert.equal(row.peakRssMb, 400)
  assert.equal(row.reclaimedMb, 250)
  assert.ok(Math.abs(row.meanRtf - 0.21) < 1e-9, `expected ~0.21, got ${row.meanRtf}`)
})

test('markdown table includes the memory columns and rounded values', () => {
  const record = normalizeReport(desktopReport(true), 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-gpu.json', 'desktop-ci')
  const markdown = renderMarkdown([record])
  assert.ok(markdown.includes('Avg RSS (MB)'))
  assert.ok(markdown.includes('Peak RSS (MB)'))
  assert.ok(markdown.includes('Reclaimed (MB)'))
  assert.ok(markdown.includes('| 410 |'), 'peak RSS should be rounded to 410 in the table')
})
