'use strict'

/**
 * Unit tests for the BCI perf-report normalizers in
 * scripts/perf-report/aggregate-bci-rtf.js.
 *
 * Covers the memory reporting behaviour:
 *   1. Avg/peak/reclaimed memory is surfaced from summary.memory on desktop
 *      artifacts, and reported as NaN when the block is absent (older
 *      artifacts stay valid).
 *   2. Mobile reports aggregate memory across run and teardown entries; the
 *      mobile peak is floored at the recorded post-load footprint so it is
 *      computed on the same basis as the desktop peak.
 *   3. The markdown and HTML tables expose the Avg / Peak / Reclaimed RSS
 *      columns with rounded values.
 *
 * Pure-function code paths only — no fixtures on disk.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/aggregate-bci-rtf.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeReport,
  normalizeMobileRecords,
  renderMarkdown,
  renderHtml
} = require('../aggregate-bci-rtf')

function desktopReport (useGPU) {
  return {
    platform: 'linux-x64',
    platformName: 'linux',
    model: { name: 'ggml-bci-windowed.bin' },
    requested: { useGPU },
    labels: { device: 'qvac-ubuntu2404-x64-gpu', backend: useGPU ? 'vulkan' : 'cpu' },
    summary: {
      tokensPerSecond: { mean: 42.5, stddev: 1.2, p50: 42 },
      wallMs: { mean: 500 },
      rtf: { mean: 0.1 },
      memory: {
        avgRssMb: 318.4,
        peakRssMb: 402.9,
        reclaimedMb: 171.2,
        rssAfterLoadMb: 300.1,
        rssAfterUnloadMb: 128.9
      }
    }
  }
}

function mobileReport (results) {
  return {
    addon: 'bci',
    addon_type: 'bci',
    device: { name: 'Pixel 9', platform: 'android' },
    results
  }
}

test('desktop record surfaces avg/peak/reclaimed memory from summary.memory', () => {
  const record = normalizeReport(desktopReport(true), 'rtf-benchmark-linux-x64-ggml-bci-windowed-gpu.json', 'desktop-ci')
  assert.equal(record.model, 'ggml-bci-windowed')
  assert.equal(record.avgRssMb, 318.4)
  assert.equal(record.peakRssMb, 402.9)
  assert.equal(record.reclaimedMb, 171.2)
})

test('desktop record reports NaN memory when summary.memory is absent', () => {
  const report = desktopReport(false)
  delete report.summary.memory
  const record = normalizeReport(report, 'rtf-benchmark-linux-x64-ggml-bci-windowed-cpu.json', 'desktop-ci')
  assert.ok(Number.isNaN(record.avgRssMb))
  assert.ok(Number.isNaN(record.peakRssMb))
  assert.ok(Number.isNaN(record.reclaimedMb))
})

test('mobile records aggregate memory across run and teardown entries', () => {
  const report = mobileReport([
    {
      test: '[ggml-bci-windowed] [CPU] mobile-perf run 1',
      execution_provider: 'cpu',
      metrics: { tps: 40, wall_time_ms: 1000, avg_rss_mb: 300, peak_rss_mb: 360 }
    },
    {
      test: '[ggml-bci-windowed] [CPU] mobile-perf run 2',
      execution_provider: 'cpu',
      metrics: { tps: 44, wall_time_ms: 1100, avg_rss_mb: 320, peak_rss_mb: 400 }
    },
    {
      test: '[ggml-bci-windowed] [CPU] mobile-perf teardown',
      execution_provider: 'cpu',
      metrics: { tps: null, reclaimed_mb: 250 }
    }
  ])
  const records = normalizeMobileRecords(report, '/x/Pixel_9/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  assert.equal(row.model, 'bci-windowed')
  assert.equal(row.avgRssMb, 310)
  assert.equal(row.peakRssMb, 400)
  assert.equal(row.reclaimedMb, 250)
})

test('mobile peak is floored at the recorded post-load footprint', () => {
  const report = mobileReport([
    {
      test: '[ggml-bci-windowed] [CPU] mobile-perf run 1',
      execution_provider: 'cpu',
      metrics: { tps: 40, wall_time_ms: 1000, avg_rss_mb: 300, peak_rss_mb: 320 }
    },
    {
      test: '[ggml-bci-windowed] [CPU] mobile-perf run 2',
      execution_provider: 'cpu',
      metrics: { tps: 44, wall_time_ms: 1100, avg_rss_mb: 310, peak_rss_mb: 330 }
    },
    {
      test: '[ggml-bci-windowed] [CPU] mobile-perf teardown',
      execution_provider: 'cpu',
      metrics: { tps: null, reclaimed_mb: 200, rss_after_load_mb: 400 }
    }
  ])
  const records = normalizeMobileRecords(report, '/x/Pixel_9/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  // Both run peaks (320, 330) are below the 400 footprint, so the floor wins,
  // matching how the desktop path clamps peak to rssAfterLoad.
  assert.equal(row.peakRssMb, 400)
})

test('markdown table includes the memory columns and rounded values', () => {
  const record = normalizeReport(desktopReport(true), 'rtf-benchmark-linux-x64-ggml-bci-windowed-gpu.json', 'desktop-ci')
  const markdown = renderMarkdown([record])
  assert.ok(markdown.includes('Avg RSS (MB)'))
  assert.ok(markdown.includes('Peak RSS (MB)'))
  assert.ok(markdown.includes('Reclaimed (MB)'))
  assert.ok(markdown.includes('| 403 |'), 'peak RSS should be rounded to 403 in the table')
  assert.ok(markdown.includes('| 318 |'), 'avg RSS should be rounded to 318 in the table')
})

test('html table includes the memory columns and rounded values', () => {
  const record = normalizeReport(desktopReport(true), 'rtf-benchmark-linux-x64-ggml-bci-windowed-gpu.json', 'desktop-ci')
  const html = renderHtml([record])
  assert.ok(html.includes('<th>Avg RSS (MB)</th>'))
  assert.ok(html.includes('<th>Peak RSS (MB)</th>'))
  assert.ok(html.includes('<th>Reclaimed (MB)</th>'))
  // Guards against the header/cell lists silently desyncing on future edits.
  assert.ok(html.includes('<td>403</td>'), 'peak RSS should be rounded to 403 in a table cell')
  assert.ok(html.includes('<td>318</td>'), 'avg RSS should be rounded to 318 in a table cell')
})
