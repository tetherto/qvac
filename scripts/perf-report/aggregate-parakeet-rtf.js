#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const SUPPORTED_GPU_BACKENDS = ['coreml', 'cuda', 'directml', 'rocm', 'nnapi']

function parseArgs (argv) {
  const args = {
    input: '',
    output: '',
    jsonOutput: '',
    htmlOutput: '',
    manualDir: path.resolve('packages/qvac-lib-infer-parakeet/benchmarks/manual-results')
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

function normalizeBackend (platformName, useGPU, backendHint) {
  const hint = String(backendHint || '').toLowerCase()
  if (hint && hint !== 'mobile-accelerated') return hint
  if (!useGPU) return 'cpu'

  switch (String(platformName || '').toLowerCase()) {
    case 'android':
      return 'nnapi'
    case 'ios':
    case 'darwin':
      return 'coreml'
    case 'linux':
      return hint || 'cuda'
    case 'win32':
      return hint || 'directml'
    default:
      return hint || 'gpu'
  }
}

function humanizeSourceFile (sourceFile) {
  if (!sourceFile) return 'unknown'
  return path.basename(sourceFile).replace(/\.[^.]+$/, '').replace(/_/g, ' ')
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

  return {
    source: 'desktop-ci',
    device: label || report.platform || 'unknown',
    platform: report.platform || 'unknown',
    platformFamily: platformName || 'unknown',
    model: report.model && report.model.type ? report.model.type : 'unknown',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend,
    meanRtf: Number(rtf.mean),
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
    gpu: useGPU ? 'gpu' : 'cpu',
    backend: normalizeBackend(platformFamily, useGPU, record.backend),
    meanRtf: Number(record.meanRtf),
    p50: Number(record.p50),
    p95: Number(record.p95),
    wallMs: Number(record.wallMs),
    notes: record.notes || ''
  }
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
      left.gpu,
      left.device
    ].join('|').localeCompare([
      right.source,
      right.platform,
      right.model,
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

  return {
    rowCount: records.length,
    gpuBackendsCovered: Array.from(gpuCoverage).sort(),
    missingBackends: SUPPORTED_GPU_BACKENDS.filter(backend => !gpuCoverage.has(backend))
  }
}

function renderMarkdown (records) {
  const lines = []
  const coverage = buildCoverage(records)

  lines.push('## Parakeet Performance Findings')
  lines.push('')
  lines.push('| Source | Device | Platform | Model | GPU | Backend | Mean RTF | P50 | P95 | Mean Wall (ms) | Notes |')
  lines.push('|--------|--------|----------|-------|-----|---------|----------|-----|-----|----------------|-------|')

  for (const record of records) {
    lines.push(
      `| ${record.source} | ${record.device} | ${record.platform} | ${record.model} | ${record.gpu} | ${record.backend} | ${formatNumber(record.meanRtf)} | ${formatNumber(record.p50)} | ${formatNumber(record.p95)} | ${formatMaybeInteger(record.wallMs)} | ${record.notes || ''} |`
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
  const rows = records.map(record => {
    return [
      record.source,
      record.device,
      record.platform,
      record.model,
      record.gpu,
      record.backend,
      formatNumber(record.meanRtf),
      formatNumber(record.p50),
      formatNumber(record.p95),
      formatMaybeInteger(record.wallMs),
      record.notes || ''
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
    '        <th>GPU</th>',
    '        <th>Backend</th>',
    '        <th>Mean RTF</th>',
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
  const manualRecords = loadManualRecords(manualDir)
  const records = sortRecords(dedupeRecords(desktopRecords.concat(manualRecords)))
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
