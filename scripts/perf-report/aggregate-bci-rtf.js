#!/usr/bin/env node
'use strict'

// Aggregates BCI throughput-benchmark artifacts (desktop rtf-benchmark-*.json +
// mobile performance-report.json) into one consolidated markdown / json / html
// report. BCI transcribes neural signal, not audio, so the headline metric is
// throughput (tokens/sec) + wall time rather than an audio real-time-factor;
// RTF is shown when the engine reports it. Mirrors aggregate-whisper-rtf.js.

const fs = require('fs')
const path = require('path')

// BCI GPU backends: Vulkan (linux/win32/android), Metal (darwin/ios), OpenCL
// (Adreno android). No CoreML/DirectML path. CUDA is disabled in the build.
const SUPPORTED_GPU_BACKENDS = ['vulkan', 'metal', 'opencl']

function parseArgs (argv) {
  const args = {
    input: '',
    output: '',
    jsonOutput: '',
    htmlOutput: '',
    manualDir: path.resolve('packages/bci-whispercpp/benchmarks/manual-results')
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if ((arg === '--input' || arg === '--dir') && next) { args.input = next; i++ } else if (arg === '--output' && next) { args.output = next; i++ } else if ((arg === '--json-output' || arg === '--output-json') && next) { args.jsonOutput = next; i++ } else if (arg === '--output-html' && next) { args.htmlOutput = next; i++ } else if (arg === '--manual-dir' && next) { args.manualDir = next; i++ }
  }

  if (!args.input) throw new Error('Missing required --input argument')
  return args
}

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function walkFiles (dir) {
  const files = []
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(fullPath))
    else files.push(fullPath)
  }
  return files
}

function ensureParentDir (filePath) {
  const dirPath = path.dirname(filePath)
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
}

function formatNumber (value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  return Number(value).toFixed(digits)
}

function formatMaybeInteger (value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  return String(Math.round(Number(value)))
}

function mean (values) {
  const nums = values.filter((value) => Number.isFinite(value))
  if (nums.length === 0) return NaN
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

function stddev (values) {
  const nums = values.filter((value) => Number.isFinite(value))
  if (nums.length === 0) return NaN
  const avg = nums.reduce((sum, value) => sum + value, 0) / nums.length
  const variance = nums.reduce((acc, value) => acc + (value - avg) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

function percentile (values, p) {
  const nums = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (nums.length === 0) return NaN
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1))
  return nums[idx]
}

function humanizeSourceFile (sourceFile) {
  if (!sourceFile) return 'unknown'
  return path.basename(sourceFile).replace(/\.[^.]+$/, '').replace(/_/g, ' ')
}

function normalizeBackend (platformName, useGPU, backendHint) {
  const hint = String(backendHint || '').toLowerCase()
  if (hint) return hint
  if (!useGPU) return 'cpu'
  switch (String(platformName || '').toLowerCase()) {
    case 'darwin':
    case 'ios':
      return 'metal'
    case 'android':
    case 'linux':
    case 'win32':
      return 'vulkan'
    default:
      return 'gpu'
  }
}

function num (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN
}

function normalizeReport (report, sourceFile, source) {
  const summary = report.summary || {}
  const tps = summary.tokensPerSecond || {}
  const wallMs = summary.wallMs || {}
  const rtf = summary.rtf || {}
  const platformName = report.platformName || report.platform || ''
  const useGPU = Boolean(report.requested && report.requested.useGPU)

  return {
    source,
    device: (report.labels && (report.labels.device || report.labels.runner)) || report.platform || 'unknown',
    platform: report.platform || 'unknown',
    platformFamily: platformName || 'unknown',
    model: report.model && report.model.name ? report.model.name.replace(/\.bin$/, '') : 'unknown',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend: normalizeBackend(platformName, useGPU, (report.labels && report.labels.backend) || (report.requested && report.requested.backendHint)),
    meanTps: num(tps.mean),
    stddevTps: num(tps.stddev),
    p50Tps: num(tps.p50),
    wallMs: num(wallMs.mean),
    rtf: num(rtf.mean),
    notes: sourceFile ? path.basename(sourceFile) : ''
  }
}

function loadArtifactRecords (inputDir) {
  const records = []
  const files = walkFiles(inputDir).filter((file) => /^rtf-benchmark-.*\.json$/.test(path.basename(file)))
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    const platformName = String(report.platformName || report.platform || '').toLowerCase()
    const source = platformName === 'android' || platformName === 'ios' ? 'mobile-ci' : 'desktop-ci'
    records.push(normalizeReport(report, file, source))
  }
  return records
}

function isMobilePerformanceReport (report) {
  return Boolean(
    report &&
    report.addon === 'bci' &&
    report.addon_type === 'bci' &&
    report.device &&
    Array.isArray(report.results)
  )
}

function mobileExecutionProvider (result) {
  const explicit = String(result.execution_provider || '').toLowerCase()
  if (explicit === 'gpu' || explicit === 'cpu') return explicit
  const testName = String(result.test || '').toLowerCase()
  if (testName.includes('[gpu]')) return 'gpu'
  if (testName.includes('[cpu]')) return 'cpu'
  return 'cpu'
}

function mobileModelTag (result) {
  const testName = String(result.test || '')
  const matches = testName.match(/\[([^\]]+)\]/g) || []
  for (const raw of matches) {
    const value = raw.slice(1, -1)
    const lower = value.toLowerCase()
    if (lower === 'cpu' || lower === 'gpu') continue
    return value.replace(/^ggml-/, '')
  }
  return 'unknown'
}

function normalizeMobileRecords (report, sourceFile) {
  const byModelAndProvider = new Map()
  const device = report.device || {}
  const platformFamily = String(device.platform || '').toLowerCase()
  const notes = path.basename(path.dirname(sourceFile))

  for (const result of report.results || []) {
    const provider = mobileExecutionProvider(result)
    const modelTag = mobileModelTag(result)
    const metrics = result.metrics || {}
    const key = `${modelTag}|${provider}`
    if (!byModelAndProvider.has(key)) {
      byModelAndProvider.set(key, { modelTag, provider, tps: [], wallMs: [], rtf: [] })
    }
    const group = byModelAndProvider.get(key)
    if (typeof metrics.tps === 'number') group.tps.push(metrics.tps)
    if (typeof metrics.wall_time_ms === 'number') group.wallMs.push(metrics.wall_time_ms)
    if (typeof metrics.real_time_factor === 'number') group.rtf.push(metrics.real_time_factor)
  }

  const records = []
  for (const values of byModelAndProvider.values()) {
    const useGPU = values.provider === 'gpu'
    records.push({
      source: 'mobile-ci',
      device: device.name || humanizeSourceFile(sourceFile),
      platform: device.platform || 'unknown',
      platformFamily: platformFamily || 'unknown',
      model: values.modelTag,
      gpu: values.provider,
      backend: normalizeBackend(platformFamily, useGPU),
      meanTps: mean(values.tps),
      stddevTps: stddev(values.tps),
      p50Tps: percentile(values.tps, 50),
      wallMs: mean(values.wallMs),
      rtf: mean(values.rtf),
      notes
    })
  }
  return records
}

function loadMobilePerformanceRecords (inputDir) {
  const records = []
  const files = walkFiles(inputDir).filter((file) => path.basename(file) === 'performance-report.json')
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isMobilePerformanceReport(report)) records.push(...normalizeMobileRecords(report, file))
  }
  return records
}

function loadManualRecords (manualDir) {
  const records = []
  if (!fs.existsSync(manualDir)) return records
  const files = walkFiles(manualDir).filter((file) => file.endsWith('.json'))
  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(payload) ? payload : (payload.records || [payload])
    for (const item of items) records.push(normalizeReport(item, file, item.source || 'manual'))
  }
  return records
}

function sortRecords (records) {
  return records.sort((left, right) => {
    return [left.source, left.platform, left.model, left.gpu, left.device].join('|')
      .localeCompare([right.source, right.platform, right.model, right.gpu, right.device].join('|'))
  })
}

function scoreRecord (record) {
  let score = 0
  if (Number.isFinite(record.meanTps)) score += 8
  if (Number.isFinite(record.p50Tps)) score += 4
  if (Number.isFinite(record.wallMs)) score += 2
  if (record.device && record.device !== 'unknown') score += 1
  if (record.notes) score += 1
  return score
}

function dedupeRecords (records) {
  const byKey = new Map()
  for (const record of records) {
    const key = [record.source, record.platform, record.platformFamily, record.model, record.gpu, record.backend, record.device].join('|')
    const existing = byKey.get(key)
    if (!existing || scoreRecord(record) > scoreRecord(existing)) byKey.set(key, record)
  }
  return [...byKey.values()]
}

function buildCoverage (records) {
  const gpuCoverage = new Set(
    records.filter((record) => record.gpu === 'gpu').map((record) => record.backend).filter(Boolean)
  )
  return {
    rowCount: records.length,
    gpuBackendsCovered: Array.from(gpuCoverage).sort(),
    missingBackends: SUPPORTED_GPU_BACKENDS.filter((backend) => !gpuCoverage.has(backend))
  }
}

function renderMarkdown (records) {
  const coverage = buildCoverage(records)
  const lines = [
    '## BCI Performance Findings',
    '',
    '| Source | Device | Platform | Model | GPU | Backend | Mean tok/s | Stddev tok/s | P50 tok/s | Mean Wall (ms) | RTF | Notes |',
    '|--------|--------|----------|-------|-----|---------|------------|--------------|-----------|----------------|-----|-------|'
  ]
  for (const record of records) {
    lines.push(
      `| ${record.source} | ${record.device} | ${record.platform} | ${record.model} | ${record.gpu} | ${record.backend} | ${formatNumber(record.meanTps)} | ${formatNumber(record.stddevTps)} | ${formatNumber(record.p50Tps)} | ${formatMaybeInteger(record.wallMs)} | ${formatNumber(record.rtf, 4)} | ${record.notes || ''} |`
    )
  }
  lines.push('')
  lines.push('### Coverage')
  lines.push('')
  lines.push(`- Rows aggregated: ${coverage.rowCount}`)
  lines.push(`- GPU backends covered: ${coverage.gpuBackendsCovered.join(', ') || 'none'}`)
  lines.push(`- GPU backends still missing: ${coverage.missingBackends.join(', ') || 'none'}`)
  return lines.join('\n') + '\n'
}

function renderHtml (records) {
  const coverage = buildCoverage(records)
  const rows = records.map((record) => {
    return [
      record.source, record.device, record.platform, record.model, record.gpu, record.backend,
      formatNumber(record.meanTps), formatNumber(record.stddevTps), formatNumber(record.p50Tps),
      formatMaybeInteger(record.wallMs), formatNumber(record.rtf, 4), record.notes || ''
    ].map((value) => `<td>${escapeHtml(value)}</td>`).join('')
  }).map((cells) => `<tr>${cells}</tr>`).join('\n')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>BCI Performance Findings</title>',
    '  <style>',
    '    body { font-family: Arial, sans-serif; margin: 24px; color: #1f2937; }',
    '    h1, h2 { margin-bottom: 12px; }',
    '    table { border-collapse: collapse; width: 100%; margin-top: 16px; }',
    '    th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; }',
    '    th { background: #f3f4f6; }',
    '    tr:nth-child(even) td { background: #f9fafb; }',
    '    ul { margin-top: 0; }',
    '    code { font-family: Menlo, Consolas, monospace; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>BCI Performance Findings</h1>',
    '  <table>',
    '    <thead>',
    '      <tr>',
    '        <th>Source</th>',
    '        <th>Device</th>',
    '        <th>Platform</th>',
    '        <th>Model</th>',
    '        <th>GPU</th>',
    '        <th>Backend</th>',
    '        <th>Mean tok/s</th>',
    '        <th>Stddev tok/s</th>',
    '        <th>P50 tok/s</th>',
    '        <th>Mean Wall (ms)</th>',
    '        <th>RTF</th>',
    '        <th>Notes</th>',
    '      </tr>',
    '    </thead>',
    '    <tbody>',
    rows,
    '    </tbody>',
    '  </table>',
    '  <h2>Coverage</h2>',
    '  <ul>',
    `    <li>Rows aggregated: <code>${escapeHtml(String(coverage.rowCount))}</code></li>`,
    `    <li>GPU backends covered: <code>${escapeHtml(coverage.gpuBackendsCovered.join(', ') || 'none')}</code></li>`,
    `    <li>GPU backends still missing: <code>${escapeHtml(coverage.missingBackends.join(', ') || 'none')}</code></li>`,
    '  </ul>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const inputDir = path.resolve(args.input)
  const manualDir = path.resolve(args.manualDir)

  const records = sortRecords(
    dedupeRecords(
      loadArtifactRecords(inputDir)
        .concat(loadMobilePerformanceRecords(inputDir))
        .concat(loadManualRecords(manualDir))
    )
  )
  const markdown = renderMarkdown(records)
  const html = renderHtml(records)

  if (args.output) {
    const outputPath = path.resolve(args.output)
    ensureParentDir(outputPath)
    fs.writeFileSync(outputPath, markdown, 'utf8')
  }
  if (args.jsonOutput) {
    const jsonOutputPath = path.resolve(args.jsonOutput)
    ensureParentDir(jsonOutputPath)
    fs.writeFileSync(jsonOutputPath, JSON.stringify({ records, coverage: buildCoverage(records) }, null, 2) + '\n', 'utf8')
  }
  if (args.htmlOutput) {
    const htmlOutputPath = path.resolve(args.htmlOutput)
    ensureParentDir(htmlOutputPath)
    fs.writeFileSync(htmlOutputPath, html, 'utf8')
  }

  process.stdout.write(markdown)
}

main()
