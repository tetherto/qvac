#!/usr/bin/env node
'use strict'

/**
 * Aggregate ONNX TTS RTF benchmark artifacts (desktop + mobile + manual) into
 * a single findings table (Markdown + JSON). Follows the same shape the
 * Parakeet aggregator produces so reviewers can compare models side-by-side.
 *
 * Usage:
 *   node scripts/perf-report/aggregate-onnx-tts-rtf.js \
 *     --dir benchmark-artifacts \
 *     --manual-dir packages/tts-onnx/benchmarks/manual-results \
 *     --output benchmark-artifacts/onnx-tts-performance-findings.md \
 *     --output-json benchmark-artifacts/onnx-tts-performance-findings.json
 */

const fs = require('fs')
const path = require('path')

const SUPPORTED_GPU_BACKENDS = ['coreml', 'directml', 'rocm', 'nnapi']
const VALID_ENGINES = ['chatterbox-en', 'chatterbox-multi', 'supertonic']
const NOISY_STDDEV_RATIO = 0.15

function parseArgs (argv) {
  const args = {
    input: '',
    output: '',
    jsonOutput: '',
    manualDir: path.resolve('packages/tts-onnx/benchmarks/manual-results')
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if ((arg === '--input' || arg === '--dir') && next) {
      args.input = next
      i++
    } else if (arg === '--output' && next) {
      args.output = next
      i++
    } else if ((arg === '--json-output' || arg === '--output-json') && next) {
      args.jsonOutput = next
      i++
    } else if (arg === '--manual-dir' && next) {
      args.manualDir = next
      i++
    }
  }

  if (!args.input) {
    throw new Error('Missing required --input / --dir argument')
  }

  return args
}

function walkFiles (dir) {
  const files = []
  if (!fs.existsSync(dir)) return files

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath))
      continue
    }
    files.push(fullPath)
  }

  return files
}

function formatNumber (value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  return Number(value).toFixed(digits)
}

function formatMaybeInteger (value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  return String(Math.round(Number(value)))
}

function normalizeBackend (platformName, useGPU, backendHint) {
  const hint = String(backendHint || '').toLowerCase()
  if (hint && hint !== 'gpu' && hint !== 'mobile-accelerated') return hint
  if (!useGPU) return 'cpu'

  switch (String(platformName || '').toLowerCase()) {
    case 'android': return 'nnapi'
    case 'ios':
    case 'darwin': return 'coreml'
    case 'linux': return hint || 'gpu'
    case 'win32': return hint || 'directml'
    default: return hint || 'gpu'
  }
}

function humanizeSourceFile (sourceFile) {
  if (!sourceFile) return 'unknown'
  return path.basename(sourceFile).replace(/\.[^.]+$/, '').replace(/_/g, ' ')
}

function isStreamingReport (report) {
  return Boolean(report && (report.kind === 'streaming' || (report.summary && report.summary.ttfaMs)))
}

function isMobileExtractedArtifact (report) {
  // Mobile-extracted reports from the RESULT_MARKER have a flat top-level
  // `variant` + `modelType` and no `runs` array. Desktop reports have a nested
  // `model.variant` and populate `runs`. Using presence-of-runs as the
  // differentiator keeps v2 desktop reports (which also carry schemaVersion)
  // from being misclassified as mobile.
  if (!report || !report.engine || !VALID_ENGINES.includes(report.engine) || !report.summary) return false
  const looksMobileShape = report.modelType && !report.model && !Array.isArray(report.runs)
  return Boolean(looksMobileShape)
}

function isDesktopArtifact (report) {
  return Boolean(report && report.engine && VALID_ENGINES.includes(report.engine) && report.summary && report.model)
}

// Canonical wrapper shape emitted by `[PERF_REPORT_START]<json>[PERF_REPORT_END]`
// markers in the mobile RTF / streaming benchmark and reassembled by
// `scripts/perf-report/extract-from-log.js` into
// `perf-results/<platform>-<variant>/<DeviceName>/performance-report.json`.
// Wraps an array of per-test results that this aggregator's normalizers do
// not understand directly (they were written for the flat `{engine,summary}`
// shape produced by the desktop benchmark's per-leg JSON artefact).
// `expandCanonicalReport` below converts each `results[]` entry into the
// shape that `normalizeMobileRecord` / `normalizeStreamingRecord` consume.
function isCanonicalReport (report) {
  return Boolean(
    report &&
    report.schema_version === '1.0' &&
    (report.addon === 'onnx-tts' || report.addon_type === 'onnx-tts') &&
    Array.isArray(report.results) &&
    report.device
  )
}

function parseCanonicalTestLabel (testLabel) {
  // The benchmark file builds `testLabel` as
  // `[${ep.toUpperCase()}] ${engine} ${variant} ${backend}` for RTF runs
  // (test/benchmark/rtf-benchmark.test.js) and the streaming-benchmark
  // mirrors that with a `streaming ` prefix between the bracket and the
  // engine. Example labels observed in mobile CI logs:
  //   `[CPU] chatterbox-en q4 cpu`
  //   `[CPU] streaming chatterbox-en q4 cpu`
  //   `[GPU] chatterbox-en q4f16 nnapi`
  const m = String(testLabel || '').match(/^\[(CPU|GPU)\]\s*(streaming\s+)?(\S+)\s+(\S+)\s+(\S+)$/)
  if (!m) return null
  return {
    useGPU: m[1] === 'GPU',
    streaming: Boolean(m[2]),
    engine: m[3],
    variant: m[4],
    backendHint: m[5]
  }
}

function expandCanonicalReport (report, sourceFile) {
  const records = []
  const streaming = []
  if (!isCanonicalReport(report)) return { records, streaming }

  const device = report.device || {}
  const platformFamily = String(device.platform || '').toLowerCase()
  const platform = device.arch ? `${platformFamily}-${device.arch}` : platformFamily

  for (const result of report.results) {
    const parsed = parseCanonicalTestLabel(result.test)
    // Warn (don't silently drop) so a drift in the on-device benchmark
    // test-label format — a variant with a space, a renamed engine, etc. —
    // is visible in the summarize job log instead of producing silent holes
    // in the findings table. Only warn for labels that *look* like benchmark
    // labels (leading `[EP]` bracket); the same merged report legitimately
    // carries the Supertonic integration perf entries (e.g. "Supertonic
    // basic synthesis"), which are not benchmark rows and are skipped quietly.
    if (!parsed) {
      if (/^\s*\[[^\]]+\]/.test(String(result.test || ''))) {
        console.warn(`[aggregate-onnx-tts-rtf] skipping benchmark-style result with unparseable label ${JSON.stringify(result.test)} (source: ${sourceFile})`)
      }
      continue
    }
    if (!VALID_ENGINES.includes(parsed.engine)) {
      console.warn(`[aggregate-onnx-tts-rtf] skipping result with unknown engine '${parsed.engine}' from label ${JSON.stringify(result.test)} (source: ${sourceFile})`)
      continue
    }

    const m = result.metrics || {}
    if (parsed.streaming) {
      streaming.push(normalizeStreamingRecord({
        engine: parsed.engine,
        modelType: parsed.engine,
        variant: parsed.variant,
        platform,
        platformName: platformFamily,
        deviceLabel: device.name,
        useGPU: parsed.useGPU,
        backendHint: parsed.backendHint,
        labels: { device: device.name, runner: device.runner, label: `${platformFamily}-streaming-${parsed.variant}` },
        summary: {
          ttfaMs: { mean: toNumberOrNull(m.ttfa_ms) },
          interChunkMs: { p95: toNumberOrNull(m.inter_chunk_p95_ms) },
          totalWallMs: { mean: toNumberOrNull(m.wall_time_ms) },
          chunkCount: { mean: toNumberOrNull(m.chunks_per_run_mean) }
        },
        correlation: { githubRunId: report.run_number }
      }, sourceFile, 'mobile-ci'))
    } else {
      records.push(normalizeMobileRecord({
        engine: parsed.engine,
        modelType: parsed.engine,
        variant: parsed.variant,
        platform,
        platformName: platformFamily,
        deviceLabel: device.name,
        runnerLabel: device.runner,
        useGPU: parsed.useGPU,
        backendHint: parsed.backendHint,
        label: `${platformFamily}-${parsed.variant}`,
        summary: {
          rtf: {
            mean: toNumberOrNull(m.real_time_factor),
            p50: toNumberOrNull(m.rtf_p50),
            p95: toNumberOrNull(m.rtf_p95)
          },
          wallMs: { mean: toNumberOrNull(m.wall_time_ms) },
          coldRtf: toNumberOrNull(m.cold_rtf),
          modelLoadMs: toNumberOrNull(m.model_load_ms),
          tokensPerSecond: { mean: toNumberOrNull(m.tps) }
        },
        correlation: { githubRunId: report.run_number }
      }, sourceFile))
    }
  }

  return { records, streaming }
}

function toNumberOrNull (value) {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function deriveNoisy (rtf, summary) {
  if (summary && typeof summary.noisy === 'boolean') return summary.noisy
  const mean = toNumberOrNull(rtf.mean)
  const stddev = toNumberOrNull(rtf.stddev)
  if (mean === null || stddev === null || mean <= 0) return null
  return (stddev / mean) > NOISY_STDDEV_RATIO
}

function buildLabel (report) {
  const label = (report.labels && report.labels.label) || (report.label || '')
  return String(label || '')
}

function normalizeDesktopRecord (report, sourceFile) {
  const summary = report.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const tps = summary.tokensPerSecond || {}
  const platformName = report.platformName || ''
  const useGPU = Boolean(report.requested && report.requested.useGPU)
  const backend = normalizeBackend(platformName, useGPU, (report.labels && report.labels.backend) || '')
  const deviceLabel = (report.labels && (report.labels.device || report.labels.runner)) || ''
  const numThreads = report.requested && report.requested.numThreads !== undefined
    ? report.requested.numThreads
    : (report.config && report.config.numThreads !== undefined ? report.config.numThreads : null)

  return {
    source: 'desktop-ci',
    device: deviceLabel || report.platform || 'unknown',
    platform: report.platform || 'unknown',
    platformFamily: platformName || 'unknown',
    engine: report.engine || 'unknown',
    variant: (report.model && report.model.variant) || (report.requested && report.requested.variant) || 'q4',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend,
    label: buildLabel(report),
    numThreads,
    meanRtf: toNumberOrNull(rtf.mean),
    p50: toNumberOrNull(rtf.p50),
    p95: toNumberOrNull(rtf.p95),
    stddev: toNumberOrNull(rtf.stddev),
    coldRtf: toNumberOrNull(summary.coldRtf),
    modelLoadMs: toNumberOrNull(summary.modelLoadMs),
    peakRssMb: summary.peakRssBytes ? Number(summary.peakRssBytes) / 1024 / 1024 : null,
    modelSizeMb: summary.modelSizeBytes ? Number(summary.modelSizeBytes) / 1024 / 1024 : (report.model && report.model.sizeBytes ? Number(report.model.sizeBytes) / 1024 / 1024 : null),
    wallMs: toNumberOrNull(wallMs.mean),
    tokensPerSecond: toNumberOrNull(tps.mean),
    noisy: deriveNoisy(rtf, summary),
    runId: (report.correlation && report.correlation.githubRunId) || '',
    sha: (report.correlation && report.correlation.githubSha) || '',
    notes: sourceFile ? path.basename(sourceFile) : ''
  }
}

function normalizeMobileRecord (record, sourceFile) {
  const summary = record.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const tps = summary.tokensPerSecond || {}
  const platformFamily = String(record.platformName || record.deviceFarmPlatform || '').toLowerCase()
  const useGPU = Boolean(record.useGPU)
  const backend = normalizeBackend(platformFamily, useGPU, record.backendHint)

  return {
    source: 'mobile-ci',
    device: record.deviceLabel || humanizeSourceFile(record.sourceFile || sourceFile),
    platform: record.platform || platformFamily || 'unknown',
    platformFamily: platformFamily || 'unknown',
    engine: record.engine || record.modelType || 'unknown',
    variant: record.variant || 'q4',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend,
    label: String((record.label || '')),
    numThreads: record.numThreads !== undefined ? record.numThreads : null,
    meanRtf: toNumberOrNull(rtf.mean),
    p50: toNumberOrNull(rtf.p50),
    p95: toNumberOrNull(rtf.p95),
    stddev: toNumberOrNull(rtf.stddev),
    coldRtf: toNumberOrNull(summary.coldRtf),
    modelLoadMs: toNumberOrNull(summary.modelLoadMs),
    peakRssMb: summary.peakRssBytes ? Number(summary.peakRssBytes) / 1024 / 1024 : null,
    modelSizeMb: summary.modelSizeBytes ? Number(summary.modelSizeBytes) / 1024 / 1024 : null,
    wallMs: toNumberOrNull(wallMs.mean),
    tokensPerSecond: toNumberOrNull(tps.mean),
    noisy: deriveNoisy(rtf, summary),
    runId: (record.correlation && record.correlation.githubRunId) || '',
    sha: (record.correlation && record.correlation.githubSha) || '',
    notes: record.runnerLabel || ''
  }
}

function normalizeManualRecord (record, sourceFile) {
  const platformFamily = String(record.platformFamily || record.platform || '').toLowerCase()
  const useGPU = record.gpu ? record.gpu === 'gpu' : Boolean(record.useGPU)

  return {
    source: record.source || 'manual',
    device: record.device || humanizeSourceFile(sourceFile),
    platform: record.platform || 'unknown',
    platformFamily: platformFamily || 'unknown',
    engine: record.engine || record.model || 'unknown',
    variant: record.variant || 'q4',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend: normalizeBackend(platformFamily, useGPU, record.backend),
    label: String(record.label || ''),
    numThreads: record.numThreads !== undefined ? record.numThreads : null,
    meanRtf: toNumberOrNull(record.meanRtf),
    p50: toNumberOrNull(record.p50),
    p95: toNumberOrNull(record.p95),
    stddev: toNumberOrNull(record.stddev),
    coldRtf: toNumberOrNull(record.coldRtf),
    modelLoadMs: toNumberOrNull(record.modelLoadMs),
    peakRssMb: toNumberOrNull(record.peakRssMb),
    modelSizeMb: toNumberOrNull(record.modelSizeMb),
    wallMs: toNumberOrNull(record.wallMs),
    tokensPerSecond: toNumberOrNull(record.tokensPerSecond),
    noisy: typeof record.noisy === 'boolean' ? record.noisy : null,
    runId: '',
    sha: '',
    notes: record.notes || ''
  }
}

function normalizeStreamingRecord (report, sourceFile, source) {
  const summary = report.summary || {}
  const ttfa = summary.ttfaMs || {}
  const interChunk = summary.interChunkMs || {}
  const totalWall = summary.totalWallMs || {}
  const chunkCount = summary.chunkCount || {}
  const platformName = report.platformName || ''
  const useGPU = Boolean((report.requested && report.requested.useGPU) || report.useGPU)
  const backend = normalizeBackend(platformName, useGPU, (report.labels && report.labels.backend) || report.backendHint || '')
  const deviceLabel = (report.labels && (report.labels.device || report.labels.runner)) || report.deviceLabel || ''

  return {
    source: source || 'desktop-ci',
    device: deviceLabel || report.platform || 'unknown',
    platform: report.platform || 'unknown',
    platformFamily: platformName || 'unknown',
    engine: report.engine || report.modelType || 'unknown',
    variant: (report.model && report.model.variant) || report.variant || 'q4',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend,
    label: String((report.labels && report.labels.label) || report.label || ''),
    ttfaMeanMs: toNumberOrNull(ttfa.mean),
    ttfaP50Ms: toNumberOrNull(ttfa.p50),
    ttfaP95Ms: toNumberOrNull(ttfa.p95),
    interChunkMeanMs: toNumberOrNull(interChunk.mean),
    interChunkP95Ms: toNumberOrNull(interChunk.p95),
    chunksPerRunMean: toNumberOrNull(chunkCount.mean),
    totalWallMeanMs: toNumberOrNull(totalWall.mean),
    runId: (report.correlation && report.correlation.githubRunId) || '',
    sha: (report.correlation && report.correlation.githubSha) || '',
    notes: sourceFile ? path.basename(sourceFile) : ''
  }
}

function loadArtifactRecords (inputDir) {
  const records = []
  const streaming = []
  const files = walkFiles(inputDir).filter(file => {
    const base = path.basename(file)
    return (
      /^rtf-benchmark-.*\.json$/.test(base) ||
      /^streaming-benchmark-.*\.json$/.test(base) ||
      // Canonical wrapper shape from mobile pipeline: extract-from-log.js
      // writes either `performance-report.json` at the platform root
      // (single-device matrix) or `<DeviceName>/performance-report.json`
      // (multi-device).
      base === 'performance-report.json'
    )
  })

  for (const file of files) {
    let report
    try {
      report = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      console.error(`Failed to parse ${file}: ${err.message}`)
      continue
    }

    // Canonical wrapper shape (mobile pipeline) — expand `results[]` into
    // per-row mobile / streaming normalizers via the same path desktop uses.
    if (isCanonicalReport(report)) {
      const expanded = expandCanonicalReport(report, file)
      records.push(...expanded.records)
      streaming.push(...expanded.streaming)
      continue
    }

    // Mobile path: the file name starts with rtf-benchmark but the writer uses
    // the flat mobile shape (no `model` object). We detect via shape, not name.
    if (isStreamingReport(report)) {
      const platformFamily = String(report.platformName || '').toLowerCase()
      const looksMobile = report.isMobile === true || platformFamily === 'android' || platformFamily === 'ios'
      streaming.push(normalizeStreamingRecord(report, file, looksMobile ? 'mobile-ci' : 'desktop-ci'))
    } else if (isMobileExtractedArtifact(report)) {
      records.push(normalizeMobileRecord(report, file))
    } else if (isDesktopArtifact(report)) {
      records.push(normalizeDesktopRecord(report, file))
    }
  }
  return { records, streaming }
}

function loadManualRecords (manualDir) {
  const records = []
  const streaming = []
  if (!fs.existsSync(manualDir)) return { records, streaming }

  const files = walkFiles(manualDir).filter(file => file.endsWith('.json'))
  for (const file of files) {
    let payload
    try {
      payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      console.error(`Failed to parse manual record ${file}: ${err.message}`)
      continue
    }

    const items = Array.isArray(payload) ? payload : (payload.records || [payload])
    for (const item of items) {
      if (isStreamingReport(item)) {
        streaming.push(normalizeStreamingRecord(item, file, 'manual'))
        continue
      }

      let record
      if (isDesktopArtifact(item)) {
        record = normalizeDesktopRecord(item, file)
      } else if (isMobileExtractedArtifact(item)) {
        record = normalizeMobileRecord(item, file)
      } else {
        record = normalizeManualRecord(item, file)
      }
      // Anything dropped under manual-results/ is by definition manual, even if
      // the payload is a copy of a CI artifact.
      record.source = 'manual'
      records.push(record)
    }
  }
  return { records, streaming }
}

function dedupeRecords (records) {
  const byKey = new Map()
  for (const record of records) {
    const key = [
      record.source,
      record.platform,
      record.engine,
      record.variant,
      record.gpu,
      record.backend,
      record.device,
      record.label || '',
      record.numThreads !== undefined && record.numThreads !== null ? String(record.numThreads) : ''
    ].join('::')
    if (!byKey.has(key)) {
      byKey.set(key, record)
    }
  }
  return [...byKey.values()]
}

function sortRecords (records) {
  return records.sort((a, b) => {
    return [
      a.source,
      a.platform,
      a.engine,
      a.gpu,
      a.device,
      a.label || '',
      a.numThreads !== undefined && a.numThreads !== null ? String(a.numThreads).padStart(3, '0') : ''
    ].join('|').localeCompare([
      b.source,
      b.platform,
      b.engine,
      b.gpu,
      b.device,
      b.label || '',
      b.numThreads !== undefined && b.numThreads !== null ? String(b.numThreads).padStart(3, '0') : ''
    ].join('|'))
  })
}

function formatLabel (label, numThreads) {
  const parts = []
  if (label) parts.push(label)
  if (numThreads !== null && numThreads !== undefined) parts.push(`threads=${numThreads}`)
  return parts.join(', ') || '-'
}

function formatModelSize (mb) {
  if (mb === null || mb === undefined || Number.isNaN(mb)) return 'n/a'
  return mb.toFixed(1)
}

function renderMarkdown (records, streamingRecords) {
  const lines = []
  const gpuCoverage = new Set(
    records.filter(r => r.gpu === 'gpu').map(r => r.backend).filter(Boolean)
  )
  const missingBackends = SUPPORTED_GPU_BACKENDS.filter(b => !gpuCoverage.has(b))
  const noisyCount = records.filter(r => r.noisy === true).length

  lines.push('## ONNX TTS Performance Findings')
  lines.push('')
  lines.push('RTF = generation_time / audio_duration. Lower is faster. RTF < 1 is faster than real-time.')
  lines.push('')
  lines.push('`Cold RTF` is the first warmup run after load (captures cold-path latency). `Noisy` flags rows where stddev / mean > 15%.')
  lines.push('')
  lines.push('| Source | Device | Platform | Engine | Variant | GPU | Backend | Label | Mean RTF | P50 | P95 | Cold RTF | Mean Wall (ms) | Load (ms) | Peak RSS (MB) | Model (MB) | Tokens/s | Noisy | Run |')
  lines.push('|--------|--------|----------|--------|---------|-----|---------|-------|----------|-----|-----|----------|----------------|-----------|---------------|------------|----------|-------|-----|')

  for (const r of records) {
    lines.push('| ' + [
      r.source,
      r.device,
      r.platform,
      r.engine,
      r.variant,
      r.gpu,
      r.backend,
      formatLabel(r.label, r.numThreads),
      formatNumber(r.meanRtf),
      formatNumber(r.p50),
      formatNumber(r.p95),
      formatNumber(r.coldRtf),
      formatMaybeInteger(r.wallMs),
      formatMaybeInteger(r.modelLoadMs),
      formatMaybeInteger(r.peakRssMb),
      formatModelSize(r.modelSizeMb),
      formatNumber(r.tokensPerSecond, 1),
      r.noisy === true ? '⚠' : '-',
      r.runId ? `#${r.runId}` : ''
    ].join(' | ') + ' |')
  }

  if (streamingRecords && streamingRecords.length > 0) {
    lines.push('')
    lines.push('### Streaming Latency (output-only: `run({ streamOutput: true })`)')
    lines.push('')
    lines.push('`TTFA` = Time-to-First-Audio from `run()` call. `Inter-chunk` = gap between successive `onUpdate` deliveries.')
    lines.push('')
    lines.push('| Source | Device | Platform | Engine | Variant | GPU | Backend | Label | TTFA Mean (ms) | TTFA P50 | TTFA P95 | Inter-chunk Mean (ms) | Inter-chunk P95 | Chunks/run | Total Wall (ms) | Run |')
    lines.push('|--------|--------|----------|--------|---------|-----|---------|-------|----------------|----------|----------|-----------------------|-----------------|------------|-----------------|-----|')
    for (const r of streamingRecords) {
      lines.push('| ' + [
        r.source,
        r.device,
        r.platform,
        r.engine,
        r.variant,
        r.gpu,
        r.backend,
        r.label || '-',
        formatMaybeInteger(r.ttfaMeanMs),
        formatMaybeInteger(r.ttfaP50Ms),
        formatMaybeInteger(r.ttfaP95Ms),
        formatMaybeInteger(r.interChunkMeanMs),
        formatMaybeInteger(r.interChunkP95Ms),
        formatNumber(r.chunksPerRunMean, 1),
        formatMaybeInteger(r.totalWallMeanMs),
        r.runId ? `#${r.runId}` : ''
      ].join(' | ') + ' |')
    }
  }

  lines.push('')
  lines.push('### Coverage')
  lines.push('')
  lines.push(`- Rows aggregated: ${records.length}` + (streamingRecords && streamingRecords.length > 0 ? ` (+ ${streamingRecords.length} streaming row(s))` : ''))
  lines.push(`- GPU backends covered: ${Array.from(gpuCoverage).sort().join(', ') || 'none'}`)
  lines.push(`- GPU backends still missing: ${missingBackends.join(', ') || 'none'}`)
  if (noisyCount > 0) {
    lines.push(`- ⚠ ${noisyCount} row(s) flagged as noisy (stddev / mean > ${Math.round(NOISY_STDDEV_RATIO * 100)}%). Treat those numbers as advisory; re-run on the stable baseline or compare P50 instead.`)
  }

  return lines.join('\n') + '\n'
}

function ensureParentDir (filePath) {
  const dirPath = path.dirname(filePath)
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const inputDir = path.resolve(args.input)
  const manualDir = path.resolve(args.manualDir)

  const fromArtifacts = loadArtifactRecords(inputDir)
  const fromManual = loadManualRecords(manualDir)

  const records = sortRecords(dedupeRecords(fromArtifacts.records.concat(fromManual.records)))
  const streaming = sortRecords(dedupeRecords(fromArtifacts.streaming.concat(fromManual.streaming)))
  const markdown = renderMarkdown(records, streaming)

  if (args.output) {
    const outputPath = path.resolve(args.output)
    ensureParentDir(outputPath)
    fs.writeFileSync(outputPath, markdown, 'utf8')
  }

  if (args.jsonOutput) {
    const jsonOutputPath = path.resolve(args.jsonOutput)
    ensureParentDir(jsonOutputPath)
    fs.writeFileSync(jsonOutputPath, JSON.stringify({ records, streaming }, null, 2) + '\n', 'utf8')
  }

  process.stdout.write(markdown)
}

main()
