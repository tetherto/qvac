'use strict'

/**
 * Unit tests for the unified perf-report normalizers in
 * scripts/perf-report/aggregate-asr-ggml-rtf.js.
 *
 * Union of the retired aggregate-whisper-rtf / aggregate-parakeet-rtf suites,
 * rewired to the merged module, plus the merge-specific behaviours:
 *   1. Engine resolution — explicit `engine`, else the pre-merge artifact shape.
 *   2. Mixed-engine dedupe must not collapse whisper/parakeet rows that share a
 *      device+lane (the two engines legitimately run the same lane).
 *   3. Mobile reports stamped `addon: 'asr-ggml'` resolve the engine from the
 *      model-type token in the test name.
 *   4. Both engines keep their quirks: whisper's bracket model tag + ggml
 *      backend-id resolution; parakeet's null-RTF derivation, post-load peak
 *      flooring and q4_0 mobile default; CPU rows never get a GPU model.
 *
 * Pure-function code paths only — no fixtures on disk.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/aggregate-asr-ggml-rtf.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveEngine,
  normalizeReport,
  normalizeDesktopRecord,
  normalizeMobileRecords,
  normalizeManualRecord,
  dedupeRecords,
  renderMarkdown,
  renderHtml,
  buildCoverage
} = require('../aggregate-asr-ggml-rtf')

function whisperDesktopReport (useGPU) {
  return {
    engine: 'whisper',
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

function parakeetDesktopReport (useGPU) {
  return {
    engine: 'parakeet',
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

// --- engine resolution -------------------------------------------------------

test('engine resolution prefers the stamped engine field', () => {
  assert.equal(resolveEngine({ engine: 'parakeet', model: { name: 'ggml-tiny.bin' } }), 'parakeet')
  assert.equal(resolveEngine({ engine: 'whisper', model: { type: 'tdt' } }), 'whisper')
})

test('engine resolution falls back to the pre-merge artifact shape', () => {
  // Pre-merge parakeet reports key the model as model.type; whisper reports key
  // it as model.name. Manual dirs still hold both.
  assert.equal(resolveEngine({ model: { type: 'ctc' } }), 'parakeet')
  assert.equal(resolveEngine({ modelType: 'eou' }), 'parakeet')
  assert.equal(resolveEngine({ model: 'sortformer-streaming' }), 'parakeet')
  assert.equal(resolveEngine({ model: { name: 'ggml-base-q5_1.bin' } }), 'whisper')
  assert.equal(resolveEngine({}), 'whisper')
})

// --- whisper desktop ---------------------------------------------------------

test('whisper desktop record surfaces avg/peak/reclaimed memory from summary.memory', () => {
  const record = normalizeReport(whisperDesktopReport(true), 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-gpu.json', 'desktop-ci')
  assert.equal(record.engine, 'whisper')
  assert.equal(record.model, 'ggml-tiny-q5_1')
  // q5_1/q5_0 were added to the quant alternation for whisper's naming.
  assert.equal(record.quant, 'q5_1')
  assert.equal(record.avgRssMb, 320.5)
  assert.equal(record.peakRssMb, 410.25)
  assert.equal(record.reclaimedMb, 180.75)
})

test('whisper desktop record reports NaN memory when summary.memory is absent', () => {
  const report = whisperDesktopReport(false)
  delete report.summary.memory
  const record = normalizeReport(report, 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-cpu.json', 'desktop-ci')
  assert.ok(Number.isNaN(record.avgRssMb))
  assert.ok(Number.isNaN(record.peakRssMb))
  assert.ok(Number.isNaN(record.reclaimedMb))
})

test('whisper desktop record leaves the parakeet-only columns empty', () => {
  const record = normalizeDesktopRecord(whisperDesktopReport(true), 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-gpu.json')
  assert.equal(record.gpuModel, null)
  assert.equal(record.version, '')
})

// --- parakeet desktop --------------------------------------------------------

test('CPU desktop row is not attributed a GPU model', () => {
  const record = normalizeDesktopRecord(parakeetDesktopReport(false), 'rtf-benchmark-win32-x64-tdt-q8_0-cpu.json')
  assert.equal(record.engine, 'parakeet')
  assert.equal(record.gpu, 'cpu')
  assert.equal(record.gpuModel, null)
})

test('GPU desktop row keeps the probed GPU model', () => {
  const record = normalizeDesktopRecord(parakeetDesktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  assert.equal(record.gpu, 'gpu')
  assert.equal(record.gpuModel, 'NVIDIA RTX 4000 SFF Ada Generation')
  assert.equal(record.version, '0.8.2')
})

test('parakeet desktop record surfaces avg/peak/reclaimed memory from summary.memory', () => {
  const record = normalizeDesktopRecord(parakeetDesktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  assert.equal(record.model, 'tdt')
  assert.equal(record.quant, 'q8_0')
  assert.equal(record.avgRssMb, 812.4)
  assert.equal(record.peakRssMb, 905.7)
  assert.equal(record.reclaimedMb, 512.3)
})

test('parakeet desktop record reports NaN memory when summary.memory is absent', () => {
  const report = parakeetDesktopReport(false)
  delete report.summary.memory
  const record = normalizeDesktopRecord(report, 'rtf-benchmark-win32-x64-tdt-q8_0-cpu.json')
  assert.ok(Number.isNaN(record.avgRssMb))
  assert.ok(Number.isNaN(record.peakRssMb))
  assert.ok(Number.isNaN(record.reclaimedMb))
})

// --- mobile ------------------------------------------------------------------

test('whisper mobile records aggregate memory across run and teardown entries', () => {
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
  assert.equal(row.engine, 'whisper')
  assert.equal(row.model, 'tiny')
  assert.equal(row.avgRssMb, 310)
  assert.equal(row.peakRssMb, 400)
  assert.equal(row.reclaimedMb, 250)
  assert.ok(Math.abs(row.meanRtf - 0.21) < 1e-9, `expected ~0.21, got ${row.meanRtf}`)
})

test('whisper mobile backend comes from the reported ggml backend id, not the platform guess', () => {
  const report = {
    addon: 'whisper',
    addon_type: 'whisper',
    device: { name: 'Galaxy S25', platform: 'android', gpu: 'Adreno 830' },
    results: [
      {
        test: '[ggml-tiny] [GPU] mobile-perf run 1',
        execution_provider: 'gpu',
        // 4 == opencl in the unified BackendId enum; the android default guess
        // would have been vulkan.
        metrics: { real_time_factor: 0.3, wall_time_ms: 900, backend_id: 4 }
      }
    ]
  }
  const [row] = normalizeMobileRecords(report, '/x/Galaxy_S25/performance-report.json')
  assert.equal(row.backend, 'opencl')
  assert.equal(row.gpuModel, 'Adreno 830')
})

test('mobile [sortformer-streaming] label maps to model sortformer-streaming, not sortformer', () => {
  // Guards the alternation ordering: `sortformer-streaming` (v2.1) must be
  // matched before `sortformer` (v1). If the order regresses, the v2.1 label
  // silently collapses onto `sortformer` and collides with v1 rows.
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
  assert.equal(row.engine, 'parakeet')
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

test('parakeet mobile records aggregate memory across run and teardown entries', () => {
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

test('older parakeet mobile rows without a quant tag default to q4_0', () => {
  const report = {
    addon: 'parakeet',
    addon_type: 'parakeet',
    device: { name: 'Pixel 9', platform: 'android' },
    results: [
      {
        test: '[ctc] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.04, wall_time_ms: 800 }
      }
    ]
  }
  const [row] = normalizeMobileRecords(report, '/x/Pixel_9/performance-report.json')
  assert.equal(row.quant, 'q4_0')
})

test("addon 'asr-ggml' mobile reports resolve the engine from the test tokens", () => {
  const report = {
    addon: 'asr-ggml',
    addon_type: 'asr-ggml',
    addonVersion: '0.1.0',
    device: { name: 'Pixel 9', platform: 'android' },
    results: [
      {
        test: '[ggml-tiny] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.2, wall_time_ms: 1000 }
      },
      {
        test: '[tdt] [q4_0] [CPU] mobile-perf run 1',
        execution_provider: 'cpu',
        metrics: { real_time_factor: 0.05, wall_time_ms: 400 }
      }
    ]
  }
  const records = normalizeMobileRecords(report, '/x/Pixel_9/performance-report.json')
  assert.equal(records.length, 2)
  const byEngine = new Map(records.map(record => [record.engine, record]))
  assert.equal(byEngine.get('whisper').model, 'tiny')
  assert.equal(byEngine.get('parakeet').model, 'tdt')
  assert.equal(byEngine.get('parakeet').quant, 'q4_0')
})

// --- manual records ----------------------------------------------------------

test('flattened manual rows keep their engine and stddev', () => {
  const record = normalizeManualRecord({
    engine: 'parakeet',
    device: 'MacBook Pro M4',
    platform: 'darwin-arm64',
    platformFamily: 'darwin',
    model: 'ctc',
    quant: 'q4_0',
    gpu: 'gpu',
    gpuModel: 'Apple M4 Pro',
    version: '0.9.1',
    meanRtf: 0.01,
    stddev: 0.001,
    p50: 0.01,
    p95: 0.012,
    wallMs: 220
  }, '/manual/parakeet/m4.json')
  assert.equal(record.engine, 'parakeet')
  assert.equal(record.source, 'manual')
  assert.equal(record.backend, 'metal')
  assert.equal(record.stddevRtf, 0.001)
  assert.equal(record.gpuModel, 'Apple M4 Pro')
})

// --- dedupe / render ---------------------------------------------------------

test('mixed-engine dedupe does not collapse rows sharing a device and lane', () => {
  // Same source/platform/model/quant/gpu/backend/device — only the engine
  // differs. `engine` is part of the dedupe key precisely so the two engines
  // running the same lane both survive.
  const base = {
    source: 'mobile-ci',
    platform: 'android',
    platformFamily: 'android',
    model: 'shared-tag',
    quant: 'q4_0',
    gpu: 'cpu',
    backend: 'cpu',
    device: 'Pixel 9',
    gpuModel: null,
    version: '0.1.0',
    meanRtf: 0.2,
    stddevRtf: 0.01,
    p50: 0.2,
    p95: 0.22,
    wallMs: 1000,
    avgRssMb: 300,
    peakRssMb: 400,
    reclaimedMb: 200,
    notes: 'Pixel_9'
  }
  const deduped = dedupeRecords([
    Object.assign({}, base, { engine: 'whisper' }),
    Object.assign({}, base, { engine: 'parakeet' })
  ])
  assert.equal(deduped.length, 2)
  assert.deepEqual(deduped.map(record => record.engine).sort(), ['parakeet', 'whisper'])
})

test('coverage reports GPU backends per engine as well as overall', () => {
  const records = [
    normalizeDesktopRecord(whisperDesktopReport(true), 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-gpu.json'),
    normalizeDesktopRecord(parakeetDesktopReport(false), 'rtf-benchmark-win32-x64-tdt-q8_0-cpu.json')
  ]
  const coverage = buildCoverage(records)
  assert.equal(coverage.rowCount, 2)
  assert.deepEqual(coverage.gpuBackendsCovered, ['vulkan'])
  assert.deepEqual(coverage.byEngine.whisper.gpuBackendsCovered, ['vulkan'])
  // The parakeet row is CPU-only, so parakeet still has zero GPU coverage even
  // though the overall table shows vulkan.
  assert.deepEqual(coverage.byEngine.parakeet.gpuBackendsCovered, [])
  assert.deepEqual(coverage.byEngine.parakeet.missingBackends, ['vulkan', 'metal', 'opencl'])
})

test('markdown table carries the Engine column, memory columns and per-engine coverage', () => {
  const records = [
    normalizeDesktopRecord(whisperDesktopReport(true), 'rtf-benchmark-linux-x64-ggml-tiny-q5_1-gpu.json'),
    normalizeDesktopRecord(parakeetDesktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  ]
  const markdown = renderMarkdown(records)
  assert.ok(markdown.includes('## ASR GGML Performance Findings'))
  assert.ok(markdown.includes('| Source | Engine | Device |'))
  assert.ok(markdown.includes('Avg RSS (MB)'))
  assert.ok(markdown.includes('Peak RSS (MB)'))
  assert.ok(markdown.includes('Reclaimed (MB)'))
  assert.ok(markdown.includes('| 410 |'), 'whisper peak RSS should be rounded to 410 in the table')
  assert.ok(markdown.includes('| 906 |'), 'parakeet peak RSS should be rounded to 906 in the table')
  assert.ok(markdown.includes('| whisper |'))
  assert.ok(markdown.includes('| parakeet |'))
  assert.ok(markdown.includes('- whisper: 1 row(s)'))
  assert.ok(markdown.includes('- parakeet: 1 row(s)'))
})

test('html table includes the Engine header, memory columns and rounded values', () => {
  const record = normalizeDesktopRecord(parakeetDesktopReport(true), 'rtf-benchmark-win32-x64-tdt-q8_0-gpu.json')
  const html = renderHtml([record])
  assert.ok(html.includes('<th>Engine</th>'))
  assert.ok(html.includes('<th>Avg RSS (MB)</th>'))
  assert.ok(html.includes('<th>Peak RSS (MB)</th>'))
  assert.ok(html.includes('<th>Reclaimed (MB)</th>'))
  // Guards against the header/cell lists silently desyncing on future edits.
  assert.ok(html.includes('<td>906</td>'), 'peak RSS should be rounded to 906 in a table cell')
  assert.ok(html.includes('<td>812</td>'), 'avg RSS should be rounded to 812 in a table cell')
  assert.ok(html.includes('<td>parakeet</td>'))
})
