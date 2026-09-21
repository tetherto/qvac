#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { listWorkflowRuns, downloadRunArtifactsParallel } = require('./gh-artifacts')

const ENGINE = 'acestep'
const ADDON = 'audiogen-ggml'
const CANONICAL_SCHEMA_VERSION = '1.0'

const SUPPORTED_GPU_BACKENDS = ['vulkan', 'metal']
const VALID_BACKENDS = [
  'cpu',
  'gpu',
  'vulkan',
  'metal',
  'cuda',
  'opencl',
  'other-gpu',
  'mobile-accelerated'
]
const VALID_DIT_VARIANTS = ['turbo-q4', 'turbo-q8', 'sft']

const NOISY_STDDEV_RATIO = 0.15
const DEFAULT_DIT_VARIANT = 'turbo-q4'
const DEFAULT_MANUAL_DIR = 'packages/audiogen-ggml/benchmarks/manual-results'
const BYTES_PER_MB = 1024 * 1024

const ARTIFACT_PATTERNS = ['rtf-results-audiogen-ggml-*', 'perf-report-audiogen-ggml-*']
const DEFAULT_FETCH_RUNS = 6

function parseArgs (argv) {
  const args = {
    input: '',
    output: '',
    jsonOutput: '',
    manualDir: path.resolve(DEFAULT_MANUAL_DIR),
    runId: '',
    workflow: '',
    runs: DEFAULT_FETCH_RUNS,
    repo: ''
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
    } else if (arg === '--run-id' && next) {
      args.runId = String(next)
      i++
    } else if (arg === '--workflow' && next) {
      args.workflow = next
      i++
    } else if (arg === '--runs' && next) {
      args.runs = Number(next) || DEFAULT_FETCH_RUNS
      i++
    } else if (arg === '--repo' && next) {
      args.repo = next
      i++
    }
  }

  if (!args.input && !args.workflow) {
    throw new Error('Missing required --input / --dir argument, or --workflow to fetch from CI')
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

function toNumberOrNull (value) {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
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
    case 'ios':
    case 'darwin':
      return 'metal'
    case 'android':
    case 'linux':
    case 'win32':
      return 'vulkan'
    default:
      return hint || 'gpu'
  }
}

function providerForBackend (backend) {
  return backend === 'cpu' ? 'cpu' : 'gpu'
}

function requestedBackendOfResult (result, platformFamily, observedBackend) {
  const hint = result.requested_backend
  if (!hint) return observedBackend
  return normalizeBackend(platformFamily, result.requested_execution_provider === 'gpu', hint)
}

function fellBackToOtherBackend (record) {
  return Boolean(record.requestedBackend) && record.requestedBackend !== record.backend
}

function normalizeDitVariant (value) {
  const variant = String(value || '').toLowerCase()
  return VALID_DIT_VARIANTS.includes(variant) ? variant : ''
}

function isCanonicalReport (report) {
  return Boolean(
    report &&
    report.schema_version === CANONICAL_SCHEMA_VERSION &&
    (report.addon === ADDON || report.addon_type === ADDON) &&
    Array.isArray(report.results) &&
    report.device
  )
}

function isDesktopArtifact (report) {
  return Boolean(report && report.engine === ENGINE && report.summary && report.model)
}

function parseCanonicalTestLabel (testLabel) {
  const matched = String(testLabel || '')
    .trim()
    .match(/^\[(CPU|GPU)\]\s+(\S+)(?:\s+(.+))?$/)
  if (!matched) return null

  const tokens = (matched[3] || '').trim().split(/\s+/).filter(Boolean)
  const takeToken = (predicate) => {
    const index = tokens.findIndex(predicate)
    return index === -1 ? null : tokens.splice(index, 1)[0]
  }
  const backendHint = takeToken((token) => VALID_BACKENDS.includes(token.toLowerCase()))
  const ditVariant = takeToken((token) => Boolean(normalizeDitVariant(token)))

  return {
    useGPU: matched[1] === 'GPU',
    engine: matched[2],
    ditVariant: ditVariant ? normalizeDitVariant(ditVariant) : '',
    backendHint
  }
}

function deriveNoisy (summary) {
  if (summary && typeof summary.noisy === 'boolean') return summary.noisy
  const rtf = (summary && summary.rtf) || {}
  const mean = toNumberOrNull(rtf.mean)
  const stddev = toNumberOrNull(rtf.stddev)
  if (mean === null || stddev === null || mean <= 0) return null
  return stddev / mean > NOISY_STDDEV_RATIO
}

function memoryFromSummary (summary) {
  const memory = (summary && summary.memory) || {}
  return {
    avgRssMb: toNumberOrNull(memory.avgRssMb),
    peakRssMb: toNumberOrNull(memory.peakRssMb),
    reclaimedMb: toNumberOrNull(memory.reclaimedMb)
  }
}

function bytesToMbOrNull (bytes) {
  const value = toNumberOrNull(bytes)
  return value === null ? null : value / BYTES_PER_MB
}

function normalizeDesktopRecord (report, sourceFile) {
  const summary = report.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const audioMs = summary.audioDurationMs || {}
  const memory = memoryFromSummary(summary)
  const labels = report.labels || {}
  const config = report.config || {}
  const platformFamily = report.platformName || ''
  const useGPU = Boolean(config.useGPU)
  const backend = normalizeBackend(platformFamily, useGPU, labels.activeBackend || labels.backend)

  return {
    source: 'desktop-ci',
    device: labels.device || labels.runner || report.platform || 'unknown',
    platform: report.platform || 'unknown',
    platformFamily: platformFamily || 'unknown',
    ditVariant:
      normalizeDitVariant((report.model && report.model.ditVariant) || config.ditVariant) ||
      DEFAULT_DIT_VARIANT,
    gpu: providerForBackend(backend),
    backend,
    requestedBackend: normalizeBackend(platformFamily, useGPU, labels.backend),
    gpuModel: labels.gpuModel || null,
    label: String(labels.label || ''),
    durationS: toNumberOrNull(config.durationS),
    inferenceSteps: toNumberOrNull(config.inferenceSteps),
    numThreads: toNumberOrNull(config.numThreads),
    meanRtf: toNumberOrNull(rtf.mean),
    p50: toNumberOrNull(rtf.p50),
    p95: toNumberOrNull(rtf.p95),
    stddev: toNumberOrNull(rtf.stddev),
    coldRtf: toNumberOrNull(summary.coldRtf),
    wallMs: toNumberOrNull(wallMs.mean),
    audioMs: toNumberOrNull(audioMs.mean),
    modelLoadMs: toNumberOrNull(summary.modelLoadMs),
    avgRssMb: memory.avgRssMb,
    peakRssMb: memory.peakRssMb,
    reclaimedMb: memory.reclaimedMb,
    modelSizeMb: bytesToMbOrNull(summary.modelSizeBytes || (report.model && report.model.sizeBytes)),
    noisy: deriveNoisy(summary),
    runId: (report.correlation && report.correlation.githubRunId) || '',
    sha: (report.correlation && report.correlation.githubSha) || '',
    notes: sourceFile ? path.basename(sourceFile) : ''
  }
}

function canonicalResultToRecord (result, report, sourceFile, runId) {
  const parsed = parseCanonicalTestLabel(result.test)
  if (!parsed || parsed.engine !== ENGINE) return null

  const metrics = result.metrics || {}
  const device = report.device || {}
  const platformFamily = String(device.platform || '').toLowerCase()
  const platform = device.arch ? `${platformFamily}-${device.arch}` : platformFamily
  const useGPU = parsed.useGPU || result.execution_provider === 'gpu'
  const ditVariant =
    parsed.ditVariant || normalizeDitVariant(result.ditVariant) || DEFAULT_DIT_VARIANT
  const backend = normalizeBackend(platformFamily, useGPU, parsed.backendHint)

  return {
    source: 'mobile-ci',
    device: device.name || platform || 'unknown',
    platform: platform || 'unknown',
    platformFamily: platformFamily || 'unknown',
    ditVariant,
    gpu: useGPU ? 'gpu' : 'cpu',
    backend,
    requestedBackend: requestedBackendOfResult(result, platformFamily, backend),
    gpuModel: device.gpu || null,
    label: `${platformFamily}-${ditVariant}`,
    durationS: null,
    inferenceSteps: null,
    numThreads: null,
    meanRtf: toNumberOrNull(metrics.real_time_factor),
    p50: toNumberOrNull(metrics.rtf_p50),
    p95: toNumberOrNull(metrics.rtf_p95),
    stddev: null,
    coldRtf: toNumberOrNull(metrics.cold_rtf),
    wallMs: toNumberOrNull(metrics.wall_time_ms),
    audioMs: toNumberOrNull(metrics.audio_duration_ms),
    modelLoadMs: toNumberOrNull(metrics.model_load_ms),
    avgRssMb: toNumberOrNull(metrics.avg_rss_mb),
    peakRssMb: toNumberOrNull(metrics.peak_rss_mb),
    reclaimedMb: toNumberOrNull(metrics.reclaimed_mb),
    modelSizeMb: null,
    noisy: null,
    runId: runId || '',
    sha: '',
    notes: sourceFile ? path.basename(sourceFile) : ''
  }
}

function expandCanonicalReport (report, sourceFile, runId) {
  if (!isCanonicalReport(report)) return []
  return report.results
    .map((result) => canonicalResultToRecord(result, report, sourceFile, runId))
    .filter(Boolean)
}

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function manualBackendOf (record) {
  return record.backend || record.provider || record.executionProvider || record.gpu
}

function manualVariantOf (record) {
  return record.ditVariant || (isPlainObject(record.model) && record.model.ditVariant)
}

function variantProblem (record) {
  const variant = manualVariantOf(record)
  if (!variant) return 'missing ditVariant'
  if (!normalizeDitVariant(variant)) {
    return `unknown ditVariant "${variant}" (expected ${VALID_DIT_VARIANTS.join(', ')})`
  }
  return null
}

function backendProblem (record) {
  const backend = manualBackendOf(record)
  if (!backend) return 'missing backend/provider'
  if (!VALID_BACKENDS.includes(String(backend).toLowerCase())) {
    return `unknown backend "${backend}" (expected ${VALID_BACKENDS.join(', ')})`
  }
  return null
}

function meanRtfProblem (record) {
  const meanRtf = toNumberOrNull(record.meanRtf)
  if (meanRtf === null || meanRtf <= 0) {
    return `meanRtf is not a positive number (${record.meanRtf})`
  }
  return null
}

function manualRecordProblems (record) {
  if (!isPlainObject(record)) return ['not a JSON object']
  const problems = []
  if (!record.device && !record.deviceLabel) problems.push('missing device')
  if (!record.platform) problems.push('missing platform')
  problems.push(variantProblem(record))
  problems.push(backendProblem(record))
  problems.push(meanRtfProblem(record))
  return problems.filter(Boolean)
}

function normalizeManualRecord (record, sourceFile) {
  const platformFamily = String(record.platformFamily || record.platformName || '').toLowerCase()
  const useGPU = Boolean(record.useGPU || record.gpu === 'gpu')
  const backend = normalizeBackend(platformFamily, useGPU, manualBackendOf(record))

  return {
    source: 'manual',
    device: record.device || record.deviceLabel || 'unknown',
    platform: record.platform || 'unknown',
    platformFamily: platformFamily || 'unknown',
    ditVariant: normalizeDitVariant(manualVariantOf(record)),
    gpu: providerForBackend(backend),
    backend,
    requestedBackend: backend,
    gpuModel: record.gpuModel || record.gpu_model || null,
    label: String(record.label || ''),
    durationS: toNumberOrNull(record.durationS),
    inferenceSteps: toNumberOrNull(record.inferenceSteps),
    numThreads: toNumberOrNull(record.numThreads),
    meanRtf: toNumberOrNull(record.meanRtf),
    p50: toNumberOrNull(record.p50),
    p95: toNumberOrNull(record.p95),
    stddev: toNumberOrNull(record.stddev),
    coldRtf: toNumberOrNull(record.coldRtf),
    wallMs: toNumberOrNull(record.wallMs),
    audioMs: toNumberOrNull(record.audioMs),
    modelLoadMs: toNumberOrNull(record.modelLoadMs),
    avgRssMb: toNumberOrNull(record.avgRssMb),
    peakRssMb: toNumberOrNull(record.peakRssMb),
    reclaimedMb: toNumberOrNull(record.reclaimedMb),
    modelSizeMb: toNumberOrNull(record.modelSizeMb),
    noisy: typeof record.noisy === 'boolean' ? record.noisy : null,
    runId: '',
    sha: '',
    notes: record.notes || (sourceFile ? path.basename(sourceFile) : '')
  }
}

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`Failed to parse ${file}: ${err.message}`)
    return null
  }
}

function isBenchmarkArtifactName (file) {
  const base = path.basename(file)
  return /^rtf-benchmark-.*\.json$/.test(base) || base === 'performance-report.json'
}

function runIdForFile (file, inputDir, explicitRunId) {
  if (explicitRunId) return explicitRunId
  const [head] = path.relative(inputDir, file).split(path.sep)
  return /^\d+$/.test(head) ? head : ''
}

function loadArtifactRecords (inputDir, runId) {
  const records = []
  for (const file of walkFiles(inputDir).filter(isBenchmarkArtifactName)) {
    const report = readJson(file)
    if (!report) continue

    if (isCanonicalReport(report)) {
      records.push(...expandCanonicalReport(report, file, runIdForFile(file, inputDir, runId)))
    } else if (isDesktopArtifact(report)) {
      records.push(normalizeDesktopRecord(report, file))
    }
  }
  return records
}

function manualItemToRecords (item, file) {
  if (isDesktopArtifact(item)) {
    return [{ ...normalizeDesktopRecord(item, file), source: 'manual' }]
  }
  if (isCanonicalReport(item)) {
    return expandCanonicalReport(item, file).map((record) => ({ ...record, source: 'manual' }))
  }

  const problems = manualRecordProblems(item)
  if (problems.length > 0) {
    console.warn(`Skipping manual record in ${file}: ${problems.join(', ')}`)
    return []
  }
  return [normalizeManualRecord(item, file)]
}

function manualItemsOf (payload) {
  if (Array.isArray(payload)) return payload
  if (isPlainObject(payload) && Array.isArray(payload.records)) return payload.records
  return [payload]
}

function loadManualRecords (manualDir) {
  const records = []
  if (!fs.existsSync(manualDir)) return records

  for (const file of walkFiles(manualDir).filter((f) => f.endsWith('.json'))) {
    const payload = readJson(file)
    if (!payload) continue
    for (const item of manualItemsOf(payload)) {
      records.push(...manualItemToRecords(item, file))
    }
  }
  return records
}

function recordKey (record) {
  return [
    record.source,
    record.platform,
    record.ditVariant,
    record.gpu,
    record.backend,
    record.requestedBackend || record.backend,
    record.device,
    record.label || '',
    record.durationS === null ? '' : String(record.durationS),
    record.numThreads === null ? '' : String(record.numThreads)
  ].join('::')
}

function dedupeRecords (records) {
  const byKey = new Map()
  for (const record of records) {
    const key = recordKey(record)
    if (!byKey.has(key)) byKey.set(key, record)
  }
  return [...byKey.values()]
}

function sortKey (record) {
  return [record.source, record.platform, record.ditVariant, record.gpu, record.device].join('|')
}

function sortRecords (records) {
  return records.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
}

function formatModelSize (mb) {
  if (mb === null || mb === undefined || Number.isNaN(mb)) return 'n/a'
  return Number(mb).toFixed(1)
}

function formatNoisy (noisy) {
  if (noisy === null || noisy === undefined) return '-'
  return noisy ? 'yes' : 'no'
}

function renderBackendCell (record) {
  if (!fellBackToOtherBackend(record)) return record.backend
  return `${record.backend} (requested ${record.requestedBackend})`
}

function missingGpuBackends (records) {
  const covered = new Set(records.filter((r) => r.gpu === 'gpu').map((r) => r.backend))
  return SUPPORTED_GPU_BACKENDS.filter((backend) => !covered.has(backend))
}

const TABLE_COLUMNS = [
  'Source',
  'Device',
  'Platform',
  'DiT Variant',
  'GPU',
  'Backend',
  'GPU Model',
  'Label',
  'Clip (s)',
  'Mean RTF',
  'P50',
  'P95',
  'Cold RTF',
  'Mean Wall (ms)',
  'Audio (ms)',
  'Load (ms)',
  'Avg RSS (MB)',
  'Peak RSS (MB)',
  'Reclaimed (MB)',
  'Model (MB)',
  'Noisy',
  'Run'
]

function renderRow (record) {
  return (
    '| ' +
    [
      record.source,
      record.device,
      record.platform,
      record.ditVariant,
      record.gpu,
      renderBackendCell(record),
      record.gpuModel || '-',
      record.label || '-',
      record.durationS === null ? '-' : formatNumber(record.durationS, 0),
      formatNumber(record.meanRtf),
      formatNumber(record.p50),
      formatNumber(record.p95),
      formatNumber(record.coldRtf),
      formatMaybeInteger(record.wallMs),
      formatMaybeInteger(record.audioMs),
      formatMaybeInteger(record.modelLoadMs),
      formatModelSize(record.avgRssMb),
      formatModelSize(record.peakRssMb),
      formatModelSize(record.reclaimedMb),
      formatModelSize(record.modelSizeMb),
      formatNoisy(record.noisy),
      record.runId || '-'
    ].join(' | ') +
    ' |'
  )
}

function renderHeader () {
  return [
    '| ' + TABLE_COLUMNS.join(' | ') + ' |',
    '|' + TABLE_COLUMNS.map(() => '---').join('|') + '|'
  ]
}

function renderIntro () {
  return [
    '## ACE-Step (audiogen-ggml) Performance Findings',
    '',
    'RTF = generation_time / audio_duration. Lower is faster; RTF < 1 is faster than real-time.',
    '',
    'The DiT variant is the model axis: `turbo-q4` and `turbo-q8` share the ~8-step turbo schedule, ' +
      '`sft` runs the ~50-step schedule and is expected to be several times slower.',
    '',
    '`Cold RTF` is the first warmup run after load (cold-path latency). ' +
      `\`Noisy\` flags rows where stddev / mean > ${Math.round(NOISY_STDDEV_RATIO * 100)}%.`,
    ''
  ]
}

function renderFooter (records) {
  const lines = ['']
  const noisyCount = records.filter((r) => r.noisy === true).length
  const fallbacks = records.filter(fellBackToOtherBackend)
  const missing = missingGpuBackends(records)

  lines.push(`Rows: ${records.length}. Noisy rows: ${noisyCount}.`)
  lines.push('')
  if (fallbacks.length > 0) {
    lines.push(
      `> ${fallbacks.length} row(s) ran on a different backend than the one requested; ` +
        'the Backend column names both. The requested backend has no coverage from those rows.'
    )
    lines.push('')
  }
  if (missing.length > 0) {
    lines.push(
      `> GPU backends with no coverage in this run: ${missing.join(', ')}. ` +
        `Drop a JSON record into \`${DEFAULT_MANUAL_DIR}/\` to fill a gap CI cannot reach.`
    )
    lines.push('')
  }
  return lines
}

function renderMarkdown (records) {
  const lines = [...renderIntro(), ...renderHeader()]
  if (records.length === 0) {
    lines.push('| _no benchmark artifacts found_ |' + TABLE_COLUMNS.slice(1).map(() => ' - |').join(''))
  }
  for (const record of records) lines.push(renderRow(record))
  lines.push(...renderFooter(records))
  return lines.join('\n') + '\n'
}

function buildJsonReport (records) {
  return {
    schemaVersion: 1,
    addon: ADDON,
    engine: ENGINE,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    missingGpuBackends: missingGpuBackends(records),
    records
  }
}

function writeOutput (file, contents) {
  if (!file) return
  const dir = path.dirname(file)
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, contents)
  console.log(`Wrote ${file}`)
}

function collectRecords (args) {
  return sortRecords(
    dedupeRecords([
      ...loadArtifactRecords(args.input, args.runId),
      ...loadManualRecords(args.manualDir)
    ])
  )
}

async function fetchWorkflowArtifacts (workflow, runs, repo) {
  const found = listWorkflowRuns(workflow, runs, repo || null)
  if (found.length === 0) {
    console.log(`No completed runs found for "${workflow}"`)
    return ''
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-rtf-'))
  console.log(`Downloading artifacts from ${found.length} run(s) of "${workflow}" into ${dir}`)
  await downloadRunArtifactsParallel(found, dir, ARTIFACT_PATTERNS, repo || null)
  return dir
}

async function resolveInputDir (args) {
  if (args.input) return args.input
  return fetchWorkflowArtifacts(args.workflow, args.runs, args.repo)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const records = collectRecords({ ...args, input: await resolveInputDir(args) })
  const markdown = renderMarkdown(records)

  if (args.output) writeOutput(args.output, markdown)
  else console.log(markdown)

  if (args.jsonOutput) {
    writeOutput(args.jsonOutput, JSON.stringify(buildJsonReport(records), null, 2) + '\n')
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = {
  ENGINE,
  ADDON,
  SUPPORTED_GPU_BACKENDS,
  VALID_BACKENDS,
  VALID_DIT_VARIANTS,
  NOISY_STDDEV_RATIO,
  parseArgs,
  runIdForFile,
  normalizeBackend,
  requestedBackendOfResult,
  fellBackToOtherBackend,
  normalizeDitVariant,
  isCanonicalReport,
  isDesktopArtifact,
  parseCanonicalTestLabel,
  deriveNoisy,
  normalizeDesktopRecord,
  expandCanonicalReport,
  normalizeManualRecord,
  manualRecordProblems,
  manualItemsOf,
  manualItemToRecords,
  loadManualRecords,
  loadArtifactRecords,
  dedupeRecords,
  sortRecords,
  missingGpuBackends,
  renderMarkdown,
  buildJsonReport
}
