'use strict'

// Pure, offline checks for the RTF benchmark's two output shapes: the on-disk
// artifact filename and the canonical [PERF_REPORT_START] record the mobile lane
// scrapes off Device Farm logs. No native addon, no models, no network.

const test = require('brittle')
const {
  ADDON_NAME,
  ENGINE_NAME,
  CANONICAL_SCHEMA_VERSION,
  backendIdToName,
  resolveBackend,
  resolveObservedBackend,
  providerForBackend,
  sanitizeTag,
  buildArtifactFileName,
  buildTestLabel,
  buildCanonicalMetrics,
  buildCanonicalReport
} = require('../utils/benchmark-report')

const DEVICE = { platform: 'linux', arch: 'x64', platformArch: 'linux-x64', isMobile: false }

function summaryFixture() {
  return {
    rtf: { mean: 1.25, p50: 1.2, p95: 1.4, count: 3 },
    wallMs: { mean: 18750.6 },
    audioDurationMs: { mean: 15000 },
    coldRtf: 1.9,
    modelLoadMs: 4210.7,
    memory: { avgRssMb: 3200.5, peakRssMb: 4100.25, reclaimedMb: 2900.1 }
  }
}

test('resolveBackend: an explicit hint always wins', (t) => {
  t.is(resolveBackend('linux', false, 'vulkan'), 'vulkan')
  t.is(resolveBackend('darwin', true, 'CPU'), 'cpu', 'hint is lowercased')
})

test('resolveBackend: CPU runs resolve to cpu regardless of platform', (t) => {
  t.is(resolveBackend('linux', false, ''), 'cpu')
  t.is(resolveBackend('darwin', false, ''), 'cpu')
  t.is(resolveBackend('android', false, ''), 'cpu')
})

test('resolveBackend: GPU runs follow the audiogen-cpp backend cascade', (t) => {
  t.is(resolveBackend('darwin', true, ''), 'metal')
  t.is(resolveBackend('ios', true, ''), 'metal')
  t.is(resolveBackend('linux', true, ''), 'vulkan')
  t.is(resolveBackend('win32', true, ''), 'vulkan')
  t.is(resolveBackend('android', true, ''), 'vulkan')
})

test('backendIdToName: maps the ggml backend ids the addon reports', (t) => {
  t.is(backendIdToName(0), 'cpu')
  t.is(backendIdToName(1), 'metal')
  t.is(backendIdToName(2), 'cuda')
  t.is(backendIdToName(3), 'vulkan')
  t.is(backendIdToName(4), 'opencl')
  t.is(backendIdToName(99), 'other-gpu')
  t.is(backendIdToName(7), '', 'an unknown id is reported as empty, not guessed')
})

test('sanitizeTag: reduces a label to a filename-safe segment', (t) => {
  t.is(sanitizeTag(''), '')
  t.is(sanitizeTag(undefined), '')
  t.is(sanitizeTag('Ubuntu 22.04 GPU'), 'ubuntu-22-04-gpu')
  t.is(sanitizeTag('--leading-and-trailing--'), 'leading-and-trailing')
})

test('buildArtifactFileName: encodes the variant and execution provider', (t) => {
  t.is(
    buildArtifactFileName('rtf-benchmark', 'linux-x64', { ditVariant: 'turbo-q4', useGPU: false }),
    'rtf-benchmark-linux-x64-turbo-q4-cpu.json'
  )
  t.is(
    buildArtifactFileName('rtf-benchmark', 'darwin-arm64', { ditVariant: 'sft', useGPU: true }),
    'rtf-benchmark-darwin-arm64-sft-gpu.json'
  )
})

test('buildArtifactFileName: appends a label only when one is set', (t) => {
  const settings = { ditVariant: 'turbo-q8', useGPU: true, label: 'qvac ubuntu2404 x64 gpu' }

  t.is(
    buildArtifactFileName('rtf-benchmark', 'linux-x64', settings),
    'rtf-benchmark-linux-x64-turbo-q8-gpu-qvac-ubuntu2404-x64-gpu.json'
  )
  t.is(
    buildArtifactFileName('rtf-benchmark', 'linux-x64', { ...settings, label: '' }),
    'rtf-benchmark-linux-x64-turbo-q8-gpu.json',
    'an empty label leaves the filename unchanged'
  )
})

test('buildTestLabel: is space-separated so the aggregator can split it', (t) => {
  t.is(
    buildTestLabel({ ditVariant: 'turbo-q4', useGPU: false }, 'cpu'),
    '[CPU] acestep turbo-q4 cpu'
  )
  t.is(buildTestLabel({ ditVariant: 'sft', useGPU: true }, 'metal'), '[GPU] acestep sft metal')
})

test('buildCanonicalMetrics: rounds durations and preserves ratios', (t) => {
  const metrics = buildCanonicalMetrics(summaryFixture())

  t.is(metrics.real_time_factor, 1.25)
  t.is(metrics.rtf_p50, 1.2)
  t.is(metrics.rtf_p95, 1.4)
  t.is(metrics.wall_time_ms, 18751, 'wall time rounds to whole milliseconds')
  t.is(metrics.audio_duration_ms, 15000)
  t.is(metrics.model_load_ms, 4211)
  t.is(metrics.cold_rtf, 1.9)
  t.is(metrics.sample_count, 3)
  t.is(metrics.peak_rss_mb, 4100.25)
})

test('buildCanonicalMetrics: missing measurements become null, never zero', (t) => {
  const metrics = buildCanonicalMetrics({ rtf: {}, wallMs: {}, audioDurationMs: {}, memory: {} })

  t.is(metrics.real_time_factor, null)
  t.is(metrics.wall_time_ms, null)
  t.is(metrics.model_load_ms, null)
  t.is(metrics.peak_rss_mb, null)
})

test('buildCanonicalReport: carries the schema the shared extractor validates', (t) => {
  const report = buildCanonicalReport({
    settings: { ditVariant: 'turbo-q4', useGPU: true },
    summary: summaryFixture(),
    backend: 'vulkan',
    device: DEVICE
  })

  t.is(report.schema_version, CANONICAL_SCHEMA_VERSION)
  t.is(report.addon, ADDON_NAME)
  t.is(report.addon_type, ADDON_NAME)
  t.is(report.results.length, 1)
  t.is(report.results[0].test, '[GPU] acestep turbo-q4 vulkan')
  t.is(report.results[0].execution_provider, 'gpu')
  t.is(report.results[0].engine, ENGINE_NAME)
  t.is(report.results[0].ditVariant, 'turbo-q4')
})

test('buildCanonicalReport: falls back to platform and CI defaults for device labels', (t) => {
  const report = buildCanonicalReport({
    settings: { ditVariant: 'sft', useGPU: false },
    summary: summaryFixture(),
    backend: 'cpu',
    device: DEVICE
  })

  t.is(report.device.name, 'linux-x64', 'platform-arch stands in for a missing device label')
  t.is(report.device.runner, 'github-actions', 'desktop runs default to the CI runner label')
  t.is(report.device.gpu, null)
})

test('resolveObservedBackend: the observed backend wins over the requested one', (t) => {
  t.is(resolveObservedBackend({ activeBackend: 'cpu' }, 'vulkan'), 'cpu')
  t.is(resolveObservedBackend({ activeBackend: 'metal' }, 'metal'), 'metal')
})

test('resolveObservedBackend: falls back when the engine reported no backend', (t) => {
  t.is(resolveObservedBackend({ activeBackend: '' }, 'vulkan'), 'vulkan', 'empty string')
  t.is(resolveObservedBackend({}, 'metal'), 'metal', 'absent field')
  t.is(resolveObservedBackend(null, 'cpu'), 'cpu', 'no summary at all')
})

test('providerForBackend: only cpu is a CPU provider', (t) => {
  t.is(providerForBackend('cpu'), 'cpu')
  for (const backend of ['metal', 'vulkan', 'cuda', 'opencl', 'other-gpu']) {
    t.is(providerForBackend(backend), 'gpu', backend)
  }
})

test('buildCanonicalReport: a GPU request that fell back to CPU reports CPU', (t) => {
  const summary = summaryFixture()
  summary.activeBackend = 'cpu'
  const report = buildCanonicalReport({
    settings: { ditVariant: 'turbo-q4', useGPU: true },
    summary,
    backend: 'vulkan',
    device: DEVICE
  })

  const result = report.results[0]
  t.is(result.test, '[CPU] acestep turbo-q4 cpu', 'label describes what actually ran')
  t.is(result.execution_provider, 'cpu', 'CPU numbers are not presented as GPU')
  t.is(result.requested_backend, 'vulkan', 'the request is still recorded')
  t.is(result.requested_execution_provider, 'gpu')
})

test('buildCanonicalReport: uses the requested backend when stats are unavailable', (t) => {
  const report = buildCanonicalReport({
    settings: { ditVariant: 'turbo-q4', useGPU: true },
    summary: summaryFixture(),
    backend: 'metal',
    device: DEVICE
  })

  t.is(report.results[0].test, '[GPU] acestep turbo-q4 metal')
  t.is(report.results[0].execution_provider, 'gpu')
})

test('buildCanonicalReport: honours explicit labels and the mobile runner default', (t) => {
  const report = buildCanonicalReport({
    settings: {
      ditVariant: 'turbo-q4',
      useGPU: true,
      deviceLabel: 'Pixel 8 Pro',
      runnerLabel: 'aws-device-farm-Android'
    },
    summary: summaryFixture(),
    backend: 'vulkan',
    device: { platform: 'android', arch: 'arm64', platformArch: 'android-arm64', isMobile: true }
  })

  t.is(report.device.name, 'Pixel 8 Pro')
  t.is(report.device.runner, 'aws-device-farm-Android')
  t.is(report.device.platform, 'android')
})
