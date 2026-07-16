'use strict'

/**
 * Unit tests for the GGML TTS perf-report normalizers in
 * scripts/perf-report/aggregate-tts-ggml-rtf.js.
 *
 * Covers the memory reporting behaviour:
 *   1. Avg/peak/reclaimed memory is surfaced from summary.memory on desktop
 *      artifacts.
 *   2. Peak RSS falls back to the legacy flat summary.peakRssBytes when the
 *      structured memory block is absent, so pre-memory artifacts still render.
 *   3. Mobile canonical reports carry avg/peak/reclaimed through the
 *      [PERF_REPORT_START] metrics into the aggregated record.
 *   4. The markdown table exposes the Avg / Peak / Reclaimed RSS columns with
 *      rounded values.
 *
 * Pure-function code paths only — no fixtures on disk.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/aggregate-tts-ggml-rtf.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeDesktopRecord,
  expandCanonicalReport,
  renderMarkdown
} = require('../aggregate-tts-ggml-rtf')

const MB = 1024 * 1024

function desktopReport (withMemory) {
  const report = {
    platform: 'linux-x64',
    platformName: 'linux',
    engine: 'chatterbox',
    model: { type: 'chatterbox', variant: 'q4', sizeBytes: 320 * MB },
    requested: { useGPU: true, variant: 'q4' },
    labels: { device: 'rtx-4090-box', backend: 'vulkan' },
    summary: {
      rtf: { mean: 0.21, p50: 0.2, p95: 0.23, stddev: 0.015 },
      wallMs: { mean: 540 },
      peakRssBytes: 1400 * MB
    }
  }
  if (withMemory) {
    report.summary.memory = {
      avgRssMb: 812.4,
      peakRssMb: 905.7,
      reclaimedMb: 512.3,
      rssAfterLoadMb: 800,
      rssAfterUnloadMb: 288
    }
  }
  return report
}

function mobileCanonicalReport () {
  return {
    schema_version: '1.0',
    addon: 'tts-ggml',
    addon_type: 'tts-ggml',
    device: { name: 'Apple iPhone 16 Pro', platform: 'ios', arch: 'arm64', runner: 'device-farm', gpu: null },
    results: [{
      test: '[GPU] chatterbox q4 metal',
      execution_provider: 'gpu',
      metrics: {
        real_time_factor: 0.3,
        rtf_p50: 0.29,
        rtf_p95: 0.35,
        wall_time_ms: 900,
        avg_rss_mb: 780,
        peak_rss_mb: 860,
        reclaimed_mb: 400
      }
    }]
  }
}

test('desktop record surfaces avg/peak/reclaimed memory from summary.memory', () => {
  const record = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  assert.equal(record.avgRssMb, 812.4)
  assert.equal(record.peakRssMb, 905.7)
  assert.equal(record.reclaimedMb, 512.3)
})

test('desktop record falls back to legacy peakRssBytes when summary.memory is absent', () => {
  const record = normalizeDesktopRecord(desktopReport(false), 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  assert.equal(record.peakRssMb, 1400)
  assert.equal(record.avgRssMb, null)
  assert.equal(record.reclaimedMb, null)
})

test('mobile canonical report carries avg/peak/reclaimed memory through metrics', () => {
  const { records } = expandCanonicalReport(mobileCanonicalReport(), '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  const [row] = records
  assert.equal(row.engine, 'chatterbox')
  assert.equal(row.variant, 'q4')
  assert.equal(row.gpu, 'gpu')
  assert.equal(row.backend, 'metal')
  assert.equal(row.avgRssMb, 780)
  assert.equal(row.peakRssMb, 860)
  assert.equal(row.reclaimedMb, 400)
})

test('markdown table includes the memory columns and rounded values', () => {
  const record = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  const markdown = renderMarkdown([record], [])
  assert.ok(markdown.includes('Avg RSS (MB)'))
  assert.ok(markdown.includes('Peak RSS (MB)'))
  assert.ok(markdown.includes('Reclaimed (MB)'))
  assert.ok(markdown.includes('| 906 |'), 'peak RSS should be rounded to 906 in the table')
  assert.ok(markdown.includes('| 812 |'), 'avg RSS should be rounded to 812 in the table')
  assert.ok(markdown.includes('| 512 |'), 'reclaimed should be rounded to 512 in the table')
})
