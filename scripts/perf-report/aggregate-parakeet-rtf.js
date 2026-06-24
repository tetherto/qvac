#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

// GGML (parakeet.cpp) GPU backend cascade: Vulkan (linux/win32/android),
// Metal (darwin/ios), OpenCL (Adreno android). CUDA is not supported on any
// platform. Previously this was the ONNX EP set (coreml/directml/nnapi/rocm),
// which never matched the GGML runtime.
const SUPPORTED_GPU_BACKENDS = ['vulkan', 'metal', 'opencl']

function parseArgs (argv) {
  const args = {
    input: '',
    output: '',
    jsonOutput: '',
    htmlOutput: '',
    manualDir: path.resolve('packages/transcription-parakeet/benchmarks/manual-results')
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--input' && next) {
      args.input = next
      i++
    } else if (arg === '--dir' && next) {
      args.input = next
      i++
    } else if (arg === '--output' && next) {
      args.output = next
      i++
    } else if (arg === '--json-output' && next) {
      args.jsonOutput = next
      i++
    } else if (arg === '--output-json' && next) {
      args.jsonOutput = next
      i++
    } else if (arg === '--output-html' && next) {
      args.htmlOutput = next
      i++
    } else if (arg === '--manual-dir' && next) {
      args.manualDir = next
      i++
    }
  }

  if (!args.input) {
    throw new Error('Missing required --input argument')
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

function mean (values) {
  const nums = values.filter(value => Number.isFinite(value))
  if (nums.length === 0) return NaN
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

// Population standard deviation, matching the desktop benchmark's stats().
function stddev (values) {
  const nums = values.filter(value => Number.isFinite(value))
  if (nums.length === 0) return NaN
  const avg = nums.reduce((sum, value) => sum + value, 0) / nums.length
  const variance = nums.reduce((sum, value) => sum + (value - avg) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

function normalizeBackend (platformName, useGPU, backendHint) {
  const hint = String(backendHint || '').toLowerCase()
  if (hint && hint !== 'mobile-accelerated' && hint !== 'gpu') return hint
  if (!useGPU) return 'cpu'

  switch (String(platformName || '').toLowerCase()) {
    case 'android':
      return 'vulkan'
    case 'ios':
    case 'darwin':
      return 'metal'
    case 'linux':
    case 'win32':
      return hint || 'vulkan'
    default:
      return hint || 'gpu'
  }
}

function humanizeSourceFile (sourceFile) {
  if (!sourceFile) return 'unknown'
  return path.basename(sourceFile).replace(/\.[^.]+$/, '').replace(/_/g, ' ')
}

// Quantisation token from a GGUF file name (e.g. `q8_0`, `q4_0`, `f16`).
// Used as a fallback when a record predates the explicit `model.quant` field.
function quantFromName (name) {
  const match = String(name || '').match(/\.(q8_0|q4_0|f16)\.gguf$/i)
  return match ? match[1].toLowerCase() : ''
}

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeDesktopRecord (report, sourceFile) {
  const summary = report.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const platformName = report.platformName || report.platform || ''
  const useGPU = Boolean(
    report.requested && report.requested.useGPU !== undefined
      ? report.requested.useGPU
      : report.config && report.config.useGPU
  )
  const backend = normalizeBackend(platformName, useGPU, report.labels && report.labels.backend)
  const label = report.labels && (report.labels.device || report.labels.runner || report.labels.label)

  const quant = (report.model && report.model.quant) ||
    quantFromName(report.model && report.model.dirName) || ''

  return {
    source: 'desktop-ci',
    device: label || report.platform || 'unknown',
    platform: report.platform || 'unknown',
    platformFamily: platformName || 'unknown',
    model: report.model && report.model.type ? report.model.type : 'unknown',
    quant,
    gpu: useGPU ? 'gpu' : 'cpu',
    backend,
    gpuModel: (report.labels && report.labels.gpuModel) || (report.device && report.device.gpu) || null,
    version: report.addonVersion || '',
    meanRtf: Number(rtf.mean),
    stddev: Number(rtf.stddev),
    p50: Number(rtf.p50),
    p95: Number(rtf.p95),
    wallMs: Number(wallMs.mean),
    notes: sourceFile ? path.basename(sourceFile) : ''
  }
}

function isDesktopArtifact (report) {
  return Boolean(report && report.model && report.model.type)
}

function normalizeManualRecord (record, sourceFile) {
  const platformFamily = String(record.platformFamily || record.platform || '').toLowerCase()
  const useGPU = record.gpu ? record.gpu === 'gpu' : Boolean(record.useGPU)

  return {
    source: record.source || 'manual',
    device: record.device || humanizeSourceFile(sourceFile),
    platform: record.platform || 'unknown',
    platformFamily: platformFamily || 'unknown',
    model: record.model || record.modelType || 'unknown',
    quant: record.quant || quantFromName(record.dirName) || '',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend: normalizeBackend(platformFamily, useGPU, record.backend),
    gpuModel: record.gpuModel || record.gpu_model || null,
    version: record.version || '',
    meanRtf: Number(record.meanRtf),
    stddev: Number(record.stddev),
    p50: Number(record.p50),
    p95: Number(record.p95),
    wallMs: Number(record.wallMs),
    notes: record.notes || ''
  }
}

function percentile (values, p) {
  const nums = values
    .filter(value => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b)
  if (nums.length === 0) return NaN
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1))
  return nums[idx]
}

function isMobilePerformanceReport (report) {
  return Boolean(
    report &&
    report.addon === 'parakeet' &&
    report.addon_type === 'parakeet' &&
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

function mobileModelType (result) {
  const testName = String(result.test || '').toLowerCase()
  const match = testName.match(/\[(tdt|ctc|eou|sortformer)\]/)
  return match ? match[1] : 'tdt'
}

// Quantisation token from the mobile test label (e.g. `[q4_0]`), stamped by
// mobile-perf-runner.js. Falls back to '' when the label predates the quant
// tag (older artifacts) so dedupe/sort still produce a single mobile row.
function mobileQuant (result) {
  const testName = String(result.test || '').toLowerCase()
  const match = testName.match(/\[(q8_0|q4_0|f16)\]/)
  return match ? match[1] : ''
}

function normalizeMobileRecords (report, sourceFile) {
  const byModelAndProvider = new Map()
  const device = report.device || {}
  const platformFamily = String(device.platform || '').toLowerCase()
  const notes = path.basename(path.dirname(sourceFile))

  for (const result of report.results || []) {
    const provider = mobileExecutionProvider(result)
    const modelType = mobileModelType(result)
    const quant = mobileQuant(result)
    const metrics = result.metrics || {}
    const key = `${modelType}|${quant}|${provider}`
    if (!byModelAndProvider.has(key)) {
      byModelAndProvider.set(key, {
        modelType,
        quant,
        provider,
        rtf: [],
        wallMs: []
      })
    }
    const group = byModelAndProvider.get(key)
    if (typeof metrics.real_time_factor === 'number') group.rtf.push(metrics.real_time_factor)
    if (typeof metrics.wall_time_ms === 'number') group.wallMs.push(metrics.wall_time_ms)
  }

  const records = []
  for (const values of byModelAndProvider.values()) {
    const useGPU = values.provider === 'gpu'
    records.push({
      source: 'mobile-ci',
      device: device.name || humanizeSourceFile(sourceFile),
      platform: device.platform || 'unknown',
      platformFamily: platformFamily || 'unknown',
      model: values.modelType,
      quant: values.quant || '',
      gpu: values.provider,
      backend: normalizeBackend(platformFamily, useGPU),
      gpuModel: device.gpu || null,
      version: report.addonVersion || '',
      meanRtf: mean(values.rtf),
      stddev: stddev(values.rtf),
      p50: percentile(values.rtf, 50),
      p95: percentile(values.rtf, 95),
      wallMs: mean(values.wallMs),
      notes
    })
  }

  return records
}

function loadArtifactRecords (inputDir) {
  const records = []
  const files = walkFiles(inputDir).filter(file => /^rtf-benchmark-.*\.json$/.test(path.basename(file)))
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isDesktopArtifact(report)) {
      records.push(normalizeDesktopRecord(report, file))
    }
  }
  return records
}

function loadMobilePerformanceRecords (inputDir) {
  const records = []
  const files = walkFiles(inputDir).filter(file => path.basename(file) === 'performance-report.json')
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isMobilePerformanceReport(report)) {
      records.push(...normalizeMobileRecords(report, file))
    }
  }
  return records
}

function loadManualRecords (manualDir) {
  const records = []
  if (!fs.existsSync(manualDir)) return records

  const files = walkFiles(manualDir).filter(file => file.endsWith('.json'))
  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(payload) ? payload : (payload.records || [payload])
    for (const item of items) {
      if (isDesktopArtifact(item)) {
        records.push(normalizeDesktopRecord(item, file))
      } else {
        records.push(normalizeManualRecord(item, file))
      }
    }
  }
  return records
}

function dedupeRecords (records) {
  const byKey = new Map()

  for (const record of records) {
    const key = [
      record.source,
      record.platform,
      record.platformFamily,
      record.model,
      record.quant,
      record.gpu,
      record.backend,
      record.device
    ].join('|')
    const existing = byKey.get(key)
    if (!existing || scoreRecord(record) > scoreRecord(existing)) {
      byKey.set(key, record)
    }
  }

  return [...byKey.values()]
}

function scoreRecord (record) {
  let score = 0
  if (Number.isFinite(record.meanRtf)) score += 8
  if (Number.isFinite(record.p50)) score += 4
  if (Number.isFinite(record.p95)) score += 4
  if (Number.isFinite(record.wallMs)) score += 2
  if (record.device && record.device !== 'unknown') score += 1
  if (record.notes) score += 1
  return score
}

function sortRecords (records) {
  return records.sort((left, right) => {
    return [
      left.source,
      left.platform,
      left.model,
      left.quant,
      left.gpu,
      left.device
    ].join('|').localeCompare([
      right.source,
      right.platform,
      right.model,
      right.quant,
      right.gpu,
      right.device
    ].join('|'))
  })
}

function buildCoverage (records) {
  const gpuCoverage = new Set(
    records
      .filter(record => record.gpu === 'gpu')
      .map(record => record.backend)
      .filter(Boolean)
  )

  const versions = Array.from(new Set(
    records.map(record => record.version).filter(Boolean)
  )).sort()

  return {
    rowCount: records.length,
    addonVersions: versions,
    gpuBackendsCovered: Array.from(gpuCoverage).sort(),
    missingBackends: SUPPORTED_GPU_BACKENDS.filter(backend => !gpuCoverage.has(backend))
  }
}

// Fastest config per device (lowest mean RTF). Mirrors the LLM suite's
// "best configuration per device" block; for an ASR addon "best" means the
// lowest real-time factor (fastest relative to audio length).
function buildBestPerDevice (records) {
  const byDevice = new Map()
  for (const record of records) {
    if (!Number.isFinite(record.meanRtf)) continue
    const key = `${record.source}|${record.device}`
    const existing = byDevice.get(key)
    if (!existing || record.meanRtf < existing.meanRtf) {
      byDevice.set(key, record)
    }
  }
  return [...byDevice.values()].sort((left, right) => {
    return `${left.source}|${left.device}`.localeCompare(`${right.source}|${right.device}`)
  })
}

function renderMarkdown (records) {
  const lines = []
  const coverage = buildCoverage(records)

  lines.push('## Parakeet Performance Findings')
  lines.push('')
  lines.push('| Source | Device | Platform | Model | Quant | GPU | Backend | GPU Model | Mean RTF | ± Stddev | P50 | P95 | Mean Wall (ms) | Notes |')
  lines.push('|--------|--------|----------|-------|-------|-----|---------|-----------|----------|----------|-----|-----|----------------|-------|')

  for (const record of records) {
    lines.push(
      `| ${record.source} | ${record.device} | ${record.platform} | ${record.model} | ${record.quant || '-'} | ${record.gpu} | ${record.backend} | ${record.gpuModel || '-'} | ${formatNumber(record.meanRtf)} | ${formatNumber(record.stddev)} | ${formatNumber(record.p50)} | ${formatNumber(record.p95)} | ${formatMaybeInteger(record.wallMs)} | ${record.notes || ''} |`
    )
  }

  lines.push('')
  lines.push('### Best configuration per device')
  lines.push('')
  lines.push('Lowest mean RTF per device (fastest relative to audio length).')
  lines.push('')
  lines.push('| Source | Device | Model | Quant | GPU | Backend | Mean RTF | ± Stddev |')
  lines.push('|--------|--------|-------|-------|-----|---------|----------|----------|')
  for (const record of buildBestPerDevice(records)) {
    lines.push(
      `| ${record.source} | ${record.device} | ${record.model} | ${record.quant || '-'} | ${record.gpu} | ${record.backend} | ${formatNumber(record.meanRtf)} | ${formatNumber(record.stddev)} |`
    )
  }

  lines.push('')
  lines.push('### Coverage')
  lines.push('')
  lines.push(`- Rows aggregated: ${coverage.rowCount}`)
  lines.push(`- Addon version(s): ${coverage.addonVersions.join(', ') || 'unknown'}`)
  lines.push(`- GPU backends covered: ${coverage.gpuBackendsCovered.join(', ') || 'none'}`)
  lines.push(`- GPU backends still missing: ${coverage.missingBackends.join(', ') || 'none'}`)

  return lines.join('\n') + '\n'
}

function renderHtml (records) {
  const coverage = buildCoverage(records)
  const rows = records.map(record => {
    return [
      record.source,
      record.device,
      record.platform,
      record.model,
      record.quant || '-',
      record.gpu,
      record.backend,
      record.gpuModel || '-',
      formatNumber(record.meanRtf),
      formatNumber(record.stddev),
      formatNumber(record.p50),
      formatNumber(record.p95),
      formatMaybeInteger(record.wallMs),
      record.notes || ''
    ].map(value => `<td>${escapeHtml(value)}</td>`).join('')
  }).map(cells => `<tr>${cells}</tr>`).join('\n')

  const bestRows = buildBestPerDevice(records).map(record => {
    return [
      record.source,
      record.device,
      record.model,
      record.quant || '-',
      record.gpu,
      record.backend,
      formatNumber(record.meanRtf),
      formatNumber(record.stddev)
    ].map(value => `<td>${escapeHtml(value)}</td>`).join('')
  }).map(cells => `<tr>${cells}</tr>`).join('\n')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Parakeet Performance Findings</title>',
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
    '  <h1>Parakeet Performance Findings</h1>',
    '  <table>',
    '    <thead>',
    '      <tr>',
    '        <th>Source</th>',
    '        <th>Device</th>',
    '        <th>Platform</th>',
    '        <th>Model</th>',
    '        <th>Quant</th>',
    '        <th>GPU</th>',
    '        <th>Backend</th>',
    '        <th>GPU Model</th>',
    '        <th>Mean RTF</th>',
    '        <th>± Stddev</th>',
    '        <th>P50</th>',
    '        <th>P95</th>',
    '        <th>Mean Wall (ms)</th>',
    '        <th>Notes</th>',
    '      </tr>',
    '    </thead>',
    '    <tbody>',
    rows,
    '    </tbody>',
    '  </table>',
    '  <h2>Best configuration per device</h2>',
    '  <p>Lowest mean RTF per device (fastest relative to audio length).</p>',
    '  <table>',
    '    <thead>',
    '      <tr>',
    '        <th>Source</th>',
    '        <th>Device</th>',
    '        <th>Model</th>',
    '        <th>Quant</th>',
    '        <th>GPU</th>',
    '        <th>Backend</th>',
    '        <th>Mean RTF</th>',
    '        <th>± Stddev</th>',
    '      </tr>',
    '    </thead>',
    '    <tbody>',
    bestRows,
    '    </tbody>',
    '  </table>',
    '  <h2>Coverage</h2>',
    '  <ul>',
    `    <li>Rows aggregated: <code>${escapeHtml(String(coverage.rowCount))}</code></li>`,
    `    <li>Addon version(s): <code>${escapeHtml(coverage.addonVersions.join(', ') || 'unknown')}</code></li>`,
    `    <li>GPU backends covered: <code>${escapeHtml(coverage.gpuBackendsCovered.join(', ') || 'none')}</code></li>`,
    `    <li>GPU backends still missing: <code>${escapeHtml(coverage.missingBackends.join(', ') || 'none')}</code></li>`,
    '  </ul>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
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

  const desktopRecords = loadArtifactRecords(inputDir)
  const mobileRecords = loadMobilePerformanceRecords(inputDir)
  const manualRecords = loadManualRecords(manualDir)
  const records = sortRecords(dedupeRecords(desktopRecords.concat(mobileRecords, manualRecords)))
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
