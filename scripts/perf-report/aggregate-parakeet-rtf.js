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

function normalizeDesktopRecord (report, sourceFile) {
  const summary = report.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const platformName = report.platformName || report.platform || ''
  const useGPU = Boolean(report.requested && report.requested.useGPU)
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

function isMobileExtractedArtifact (report) {
  return Boolean(report && report.modelType && report.summary)
}

function normalizeMobileRecord (record, sourceFile) {
  const summary = record.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const platformFamily = String(record.platformName || record.deviceFarmPlatform || '').toLowerCase()
  const useGPU = Boolean(record.useGPU)

  return {
    source: 'mobile-ci',
    device: humanizeSourceFile(record.sourceFile || sourceFile),
    platform: record.platform || record.deviceFarmPlatform || platformFamily || 'unknown',
    platformFamily: platformFamily || 'unknown',
    model: record.modelType || 'unknown',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend: normalizeBackend(platformFamily, useGPU, record.backendHint),
    meanRtf: Number(rtf.mean),
    p50: Number(rtf.p50),
    p95: Number(rtf.p95),
    wallMs: Number(wallMs.mean),
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
      continue
    }
    if (isMobileExtractedArtifact(report)) {
      records.push(normalizeMobileRecord(report, file))
    }
  }
  return records
}

function loadMobileRecords (inputDir) {
  const records = []
  const files = walkFiles(inputDir).filter(file => /^rtf-results-.*\.jsonl$/.test(path.basename(file)))
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8').trim()
    if (!content) continue
    for (const line of content.split(/\r?\n/)) {
      const record = JSON.parse(line)
      records.push(normalizeMobileRecord(record, file))
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
      } else if (isMobileExtractedArtifact(item)) {
        records.push(normalizeMobileRecord(item, file))
      } else {
        records.push(normalizeManualRecord(item, file))
      }
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
  const lines = []
  const gpuCoverage = new Set(
    records
      .filter(record => record.gpu === 'gpu')
      .map(record => record.backend)
      .filter(Boolean)
  )
  const missingBackends = SUPPORTED_GPU_BACKENDS.filter(backend => !gpuCoverage.has(backend))

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
  lines.push(`- Rows aggregated: ${records.length}`)
  lines.push(`- GPU backends covered: ${Array.from(gpuCoverage).sort().join(', ') || 'none'}`)
  lines.push(`- GPU backends still missing: ${missingBackends.join(', ') || 'none'}`)

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

  const desktopRecords = loadArtifactRecords(inputDir)
  const mobileRecords = loadMobileRecords(inputDir)
  const manualRecords = loadManualRecords(manualDir)
  const records = sortRecords(desktopRecords.concat(mobileRecords, manualRecords))
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
