'use strict'

// Pure builders for the on-disk `rtf-benchmark-*.json` artifact and the
// canonical `[PERF_REPORT_START]` record the mobile lane emits. Kept out of the
// brittle suite so they stay unit-testable without the native addon.

const ENGINE_NAME = 'acestep'

// Schema version for the on-disk artifact. Bump when a consumer-visible field
// changes shape so the aggregator can reject stale drops.
const RTF_REPORT_SCHEMA_VERSION = 1

// extract-from-log.js validates on a string schema_version plus a results array.
const CANONICAL_SCHEMA_VERSION = '1.0'

const ADDON_NAME = 'audiogen-ggml'

// ggml backend ids as reported by AudiogenStats.backendId.
const BACKEND_NAMES = {
  0: 'cpu',
  1: 'metal',
  2: 'cuda',
  3: 'vulkan',
  4: 'opencl',
  99: 'other-gpu'
}

function backendIdToName(id) {
  return BACKEND_NAMES[id] || ''
}

// CUDA is outside the default cascade, so it only appears when a hint asks.
function resolveBackend(platformName, useGPU, backendHint) {
  const hint = String(backendHint || '').toLowerCase()
  if (hint) return hint
  if (!useGPU) return 'cpu'
  if (platformName === 'darwin' || platformName === 'ios') return 'metal'
  return 'vulkan'
}

function sanitizeTag(value) {
  if (!value) return ''
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildArtifactFileName(prefix, platformArch, settings) {
  const parts = [prefix, platformArch, settings.ditVariant, settings.useGPU ? 'gpu' : 'cpu']
  const label = sanitizeTag(settings.label)
  if (label) parts.push(label)
  return `${parts.join('-')}.json`
}

function providerForBackend(backend) {
  return backend === 'cpu' ? 'cpu' : 'gpu'
}

// A GPU request that the engine could not honour still runs, so the label must
// describe the backend that executed rather than the one that was asked for.
// Stats are absent only when no run reported a backend id.
function resolveObservedBackend(summary, requestedBackend) {
  return (summary && summary.activeBackend) || requestedBackend
}

// Space-separated so the aggregator can split the label back into
// [execution provider, engine, variant, backend].
function buildTestLabel(settings, backend) {
  const provider = providerForBackend(backend).toUpperCase()
  return `[${provider}] ${ENGINE_NAME} ${settings.ditVariant} ${backend}`
}

function toRoundedOrNull(value) {
  return Number.isFinite(value) ? Math.round(value) : null
}

function toNumberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function buildCanonicalMetrics(summary) {
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const audioMs = summary.audioDurationMs || {}
  const memory = summary.memory || {}
  return {
    real_time_factor: toNumberOrNull(rtf.mean),
    rtf_p50: toNumberOrNull(rtf.p50),
    rtf_p95: toNumberOrNull(rtf.p95),
    wall_time_ms: toRoundedOrNull(wallMs.mean),
    audio_duration_ms: toRoundedOrNull(audioMs.mean),
    cold_rtf: toNumberOrNull(summary.coldRtf),
    model_load_ms: toRoundedOrNull(summary.modelLoadMs),
    sample_count: toNumberOrNull(rtf.count),
    avg_rss_mb: toNumberOrNull(memory.avgRssMb),
    peak_rss_mb: toNumberOrNull(memory.peakRssMb),
    reclaimed_mb: toNumberOrNull(memory.reclaimedMb)
  }
}

function buildCanonicalReport({ settings, summary, backend, device }) {
  const observedBackend = resolveObservedBackend(summary, backend)
  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    addon: ADDON_NAME,
    addon_type: ADDON_NAME,
    timestamp: new Date().toISOString(),
    device: {
      name: settings.deviceLabel || device.platformArch,
      platform: device.platform,
      os_version: '',
      arch: device.arch,
      gpu: device.gpu || null,
      cpu: device.cpu || null,
      runner: settings.runnerLabel || (device.isMobile ? 'device-farm' : 'github-actions')
    },
    results: [
      {
        test: buildTestLabel(settings, observedBackend),
        execution_provider: providerForBackend(observedBackend),
        requested_backend: backend,
        requested_execution_provider: settings.useGPU ? 'gpu' : 'cpu',
        engine: ENGINE_NAME,
        ditVariant: settings.ditVariant,
        metrics: buildCanonicalMetrics(summary)
      }
    ]
  }
}

module.exports = {
  ENGINE_NAME,
  ADDON_NAME,
  RTF_REPORT_SCHEMA_VERSION,
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
}
