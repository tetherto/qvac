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
  normalizeManualRecord,
  expandCanonicalReport,
  dedupeRecords,
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
      quality: {
        model: 'ggml-small.bin',
        wer: { mean: 0.125 },
        cer: { mean: 0.0625 }
      },
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
      qualityModel: 'ggml-tiny.bin',
      metrics: {
        real_time_factor: 0.3,
        rtf_p50: 0.29,
        rtf_p95: 0.35,
        wall_time_ms: 900,
        word_error_rate: 0.2,
        character_error_rate: 0.1,
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
  assert.equal(row.meanWer, 0.2)
  assert.equal(row.meanCer, 0.1)
  assert.equal(row.qualityModel, 'ggml-tiny.bin')
})

test('manual record reads the LavaSR axes from a model block, mirroring the desktop reader', () => {
  const record = normalizeManualRecord(
    {
      source: 'manual',
      engine: 'supertonic',
      variant: 'q4',
      model: { enhancer: 'lavasr', enhancerVariant: 'q8_0', denoiser: 'lavasr' },
      meanRtf: 0.3
    },
    'manual-lavasr.json'
  )
  assert.equal(record.enhancer, 'lavasr')
  assert.equal(record.enhancerVariant, 'q8_0')
  assert.equal(record.denoiser, 'lavasr')
})

test('manual record still reads top-level LavaSR axes when there is no model block', () => {
  const record = normalizeManualRecord(
    { source: 'manual', engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'f32', denoiser: 'lavasr' },
    'manual-lavasr-flat.json'
  )
  assert.equal(record.enhancer, 'lavasr')
  assert.equal(record.enhancerVariant, 'f32')
  assert.equal(record.denoiser, 'lavasr')
})

test('manual record with a string model keeps it as the engine name and defaults the axes off', () => {
  const record = normalizeManualRecord({ source: 'manual', model: 'supertonic' }, 'manual-legacy.json')
  assert.equal(record.engine, 'supertonic')
  assert.equal(record.enhancer, 'none')
  assert.equal(record.denoiser, 'none')
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

test('desktop record and markdown surface optional CER and WER', () => {
  const record = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  assert.equal(record.meanWer, 0.125)
  assert.equal(record.meanCer, 0.0625)
  assert.equal(record.qualityModel, 'ggml-small.bin')

  const markdown = renderMarkdown([record], [])
  assert.ok(markdown.includes('Mean WER'))
  assert.ok(markdown.includes('Mean CER'))
  assert.ok(markdown.includes('Quality Model'))
  assert.ok(markdown.includes('ggml-small.bin'))
  assert.ok(markdown.includes('| 12.50% | 6.25% |'))
})

test('desktop record leaves CER and WER empty for legacy artifacts', () => {
  const report = desktopReport(true)
  delete report.summary.quality
  const record = normalizeDesktopRecord(report, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  assert.equal(record.meanWer, null)
  assert.equal(record.meanCer, null)
  assert.equal(record.qualityModel, null)
  assert.ok(renderMarkdown([record], []).includes('| n/a | n/a |'))
})

test('desktop record defaults enhancer to none and surfaces model.enhancer when set', () => {
  const none = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  assert.equal(none.enhancer, 'none')

  const report = desktopReport(true)
  report.model.enhancer = 'lavasr'
  const withEnhancer = normalizeDesktopRecord(report, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu-lavasr.json')
  assert.equal(withEnhancer.enhancer, 'lavasr')
})

test('mobile canonical report parses the trailing enhancer token', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal lavasr'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  assert.equal(records[0].engine, 'chatterbox')
  assert.equal(records[0].backend, 'metal')
  assert.equal(records[0].enhancer, 'lavasr')
})

test('mobile canonical report without an enhancer token defaults to none (backward compat)', () => {
  const { records } = expandCanonicalReport(mobileCanonicalReport(), '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records[0].enhancer, 'none')
})

test('mobile canonical report falls back to the record-level enhancer when the label has no token', () => {
  // Legacy 5-token label (no enhancer token) but the record carries
  // enhancer: 'lavasr'. The label default of 'none' must not shadow it.
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal'
  report.results[0].enhancer = 'lavasr'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  assert.equal(records[0].enhancer, 'lavasr')
})

test('mobile canonical report prefers the label enhancer token over the record field', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal lavasr'
  report.results[0].enhancer = 'none'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records[0].enhancer, 'lavasr')
})

test('mobile canonical streaming report parses the trailing enhancer token', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[CPU] streaming chatterbox q4 cpu lavasr'
  report.results[0].metrics = {
    ttfa_ms: 120,
    inter_chunk_p95_ms: 40,
    wall_time_ms: 900,
    chunks_per_run_mean: 5
  }
  const { streaming } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(streaming.length, 1)
  assert.equal(streaming[0].engine, 'chatterbox')
  assert.equal(streaming[0].enhancer, 'lavasr')
})

test('markdown table exposes the Enhancer column and the lavasr value', () => {
  const report = desktopReport(true)
  report.model.enhancer = 'lavasr'
  const record = normalizeDesktopRecord(report, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu-lavasr.json')
  const markdown = renderMarkdown([record], [])
  assert.ok(markdown.includes('| Enhancer |'), 'header carries the Enhancer column')
  assert.ok(markdown.includes('| lavasr |'), 'enhancer value rendered in the row')
})

test('desktop record defaults denoiser to none and surfaces model.denoiser when set', () => {
  const none = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  assert.equal(none.denoiser, 'none')

  const report = desktopReport(true)
  report.model.denoiser = 'lavasr'
  const withDenoiser = normalizeDesktopRecord(report, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu-denoise.json')
  assert.equal(withDenoiser.denoiser, 'lavasr')
})

test('mobile canonical report parses the trailing denoise token as the denoiser axis', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal denoise'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  assert.equal(records[0].enhancer, 'none', 'no lavasr token -> enhancer stays none')
  assert.equal(records[0].denoiser, 'lavasr', 'denoise token -> denoiser on')
})

test('mobile canonical report parses both lavasr and denoise tokens unambiguously', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal lavasr denoise'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records.length, 1)
  assert.equal(records[0].backend, 'metal', 'backend is not swallowed by the trailing tokens')
  assert.equal(records[0].enhancer, 'lavasr')
  assert.equal(records[0].denoiser, 'lavasr')
})

test('mobile canonical report without a denoise token defaults the denoiser to none', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal lavasr'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records[0].denoiser, 'none')
})

test('mobile canonical report falls back to the record-level denoiser when the label has no token', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal'
  report.results[0].denoiser = 'lavasr'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records[0].denoiser, 'lavasr')
})

test('mobile canonical streaming report parses both trailing tokens', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[CPU] streaming chatterbox q4 cpu lavasr denoise'
  report.results[0].metrics = {
    ttfa_ms: 120,
    inter_chunk_p95_ms: 40,
    wall_time_ms: 900,
    chunks_per_run_mean: 5
  }
  const { streaming } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(streaming.length, 1)
  assert.equal(streaming[0].enhancer, 'lavasr')
  assert.equal(streaming[0].denoiser, 'lavasr')
})

test('markdown table exposes the Denoiser column and the lavasr value', () => {
  const report = desktopReport(true)
  report.model.denoiser = 'lavasr'
  const record = normalizeDesktopRecord(report, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu-denoise.json')
  const markdown = renderMarkdown([record], [])
  assert.ok(markdown.includes('| Denoiser |'), 'header carries the Denoiser column')
  assert.ok(markdown.includes('| lavasr |'), 'denoiser value rendered in the row')
})

test('desktop record defaults enhancerVariant to fp16 and surfaces model.enhancerVariant', () => {
  const def = normalizeDesktopRecord(desktopReport(true), 'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json')
  assert.equal(def.enhancerVariant, 'f16')

  const report = desktopReport(true)
  report.model.enhancer = 'lavasr'
  report.model.enhancerVariant = 'q8_0'
  const record = normalizeDesktopRecord(report, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu-lavasr-q8_0.json')
  assert.equal(record.enhancerVariant, 'q8_0')
})

test('mobile canonical report carries the record-level enhancerVariant (default fp16)', () => {
  const def = expandCanonicalReport(mobileCanonicalReport(), '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(def.records[0].enhancerVariant, 'f16')

  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 metal lavasr'
  report.results[0].enhancerVariant = 'q8_0'
  const { records } = expandCanonicalReport(report, '/x/Apple_iPhone_16_Pro/performance-report.json')
  assert.equal(records[0].enhancer, 'lavasr')
  assert.equal(records[0].enhancerVariant, 'q8_0')
})

test('markdown renders the fp16 enhancer as plain lavasr (byte-stable) and a quant tier as lavasr/<tier>', () => {
  const fp16 = desktopReport(true)
  fp16.model.enhancer = 'lavasr'
  const fp16Record = normalizeDesktopRecord(fp16, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu-lavasr.json')
  assert.ok(renderMarkdown([fp16Record], []).includes('| lavasr |'), 'fp16 stays plain lavasr')

  const quant = desktopReport(true)
  quant.model.enhancer = 'lavasr'
  quant.model.enhancerVariant = 'q8_0'
  const quantRecord = normalizeDesktopRecord(quant, 'rtf-benchmark-linux-x64-chatterbox-q4-gpu-lavasr-q8_0.json')
  const markdown = renderMarkdown([quantRecord], [])
  assert.ok(markdown.includes('| lavasr/q8_0 |'), 'a non-fp16 tier renders as lavasr/<tier>')
})

test('dedupeRecords keeps rows that differ only by enhancer quant tier as separate rows', () => {
  function lavasrRecord (enhancerVariant) {
    const report = desktopReport(true)
    report.model.enhancer = 'lavasr'
    report.model.enhancerVariant = enhancerVariant
    return normalizeDesktopRecord(report, `rtf-benchmark-linux-x64-chatterbox-q4-gpu-lavasr-${enhancerVariant}.json`)
  }

  const deduped = dedupeRecords([lavasrRecord('f16'), lavasrRecord('q8_0'), lavasrRecord('q8_0')])
  assert.equal(deduped.length, 2, 'f16 and q8_0 survive; the duplicate q8_0 collapses')
  const tiers = deduped.map((r) => r.enhancerVariant).sort()
  assert.deepEqual(tiers, ['f16', 'q8_0'])
})

test('dedupeRecords keeps rows evaluated by different Whisper models separate', () => {
  const small = normalizeDesktopRecord(
    desktopReport(true),
    'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json'
  )
  const tinyReport = desktopReport(true)
  tinyReport.summary.quality.model = 'ggml-tiny.bin'
  const tiny = normalizeDesktopRecord(
    tinyReport,
    'rtf-benchmark-linux-x64-chatterbox-q4-gpu.json'
  )

  assert.equal(dedupeRecords([small, tiny]).length, 2)
})
