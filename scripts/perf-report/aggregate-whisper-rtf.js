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
    manualDir: path.resolve('packages/qvac-lib-infer-whispercpp/benchmarks/manual-results')
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
    } else {
      files.push(fullPath)
    }
  }

  return files
}

function ensureParentDir (filePath) {
  const dirPath = path.dirname(filePath)
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
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
  if (hint) return hint
  if (!useGPU) return 'cpu'

  switch (String(platformName || '').toLowerCase()) {
    case 'darwin':
    case 'ios':
      return 'coreml'
    case 'win32':
      return 'directml'
    case 'android':
      return 'nnapi'
    case 'linux':
      return 'cuda'
    default:
      return 'gpu'
  }
}

function normalizeReport (report, sourceFile, source) {
  const summary = report.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
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
    meanRtf: Number(rtf.mean),
    p50: Number(rtf.p50),
    p95: Number(rtf.p95),
    wallMs: Number(wallMs.mean),
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

function loadManualRecords (manualDir) {
  const records = []
  if (!fs.existsSync(manualDir)) return records

  const files = walkFiles(manualDir).filter((file) => file.endsWith('.json'))
  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(payload) ? payload : (payload.records || [payload])
    for (const item of items) {
      records.push(normalizeReport(item, file, item.source || 'manual'))
    }
  }

  return records
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

function renderMarkdown (records) {
  const gpuCoverage = new Set(
    records
      .filter((record) => record.gpu === 'gpu')
      .map((record) => record.backend)
      .filter(Boolean)
  )
  const missingBackends = SUPPORTED_GPU_BACKENDS.filter((backend) => !gpuCoverage.has(backend))

  const lines = [
    '## Whisper Performance Findings',
    '',
    '| Source | Device | Platform | Model | GPU | Backend | Mean RTF | P50 | P95 | Mean Wall (ms) | Notes |',
    '|--------|--------|----------|-------|-----|---------|----------|-----|-----|----------------|-------|'
  ]

  for (const record of records) {
    lines.push(
      `| ${record.source} | ${record.device} | ${record.platform} | ${record.model} | ${record.gpu} | ${record.backend} | ${formatNumber(record.meanRtf)} | ${formatNumber(record.p50)} | ${formatNumber(record.p95)} | ${formatMaybeInteger(record.wallMs)} | ${record.notes || ''} |`
    )
  }

  lines.push('')
  lines.push('### Coverage')
  lines.push('')
  lines.push(`- Rows aggregated: ${records.length}`)
  lines.push(`- GPU backends covered: ${Array.from(gpuCoverage).sort().join(', ') || 'none'}`)
  lines.push(`- GPU backends still missing: ${missingBackends.join(', ') || 'none'}`)

  return lines.join('\n') + '\n'
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const inputDir = path.resolve(args.input)
  const manualDir = path.resolve(args.manualDir)

  const records = sortRecords(
    loadArtifactRecords(inputDir).concat(loadManualRecords(manualDir))
  )
  const markdown = renderMarkdown(records)

  if (args.output) {
    const outputPath = path.resolve(args.output)
    ensureParentDir(outputPath)
    fs.writeFileSync(outputPath, markdown, 'utf8')
  }

  if (args.jsonOutput) {
    const jsonOutputPath = path.resolve(args.jsonOutput)
    ensureParentDir(jsonOutputPath)
    fs.writeFileSync(jsonOutputPath, JSON.stringify({ records }, null, 2) + '\n', 'utf8')
  }

  process.stdout.write(markdown)
}

main()
