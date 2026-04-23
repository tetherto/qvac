#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const RESULT_MARKER = 'QVAC_RTF_REPORT::'
const DEFAULT_MANIFEST_NAME = 'mobile-rtf-extraction-manifest.json'
const AUTO_METADATA_FILE = 'devicefarm-artifacts.jsonl'

function parseArgs (argv) {
  const args = {
    inputDirs: [],
    outputDir: '',
    manifestPath: ''
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--input-dir') {
      args.inputDirs.push(path.resolve(argv[++i]))
      continue
    }

    if (arg === '--output-dir') {
      args.outputDir = path.resolve(argv[++i])
      continue
    }

    if (arg === '--manifest') {
      args.manifestPath = path.resolve(argv[++i])
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (args.inputDirs.length === 0) {
    throw new Error('At least one --input-dir is required')
  }

  if (!args.outputDir) {
    throw new Error('--output-dir is required')
  }

  if (!args.manifestPath) {
    args.manifestPath = path.join(args.outputDir, DEFAULT_MANIFEST_NAME)
  }

  return args
}

function walkFiles (targetDir) {
  if (!fs.existsSync(targetDir)) return []

  const entries = fs.readdirSync(targetDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))

  const files = []
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath))
      continue
    }
    if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

function sanitizeSegment (value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || 'unknown'
}

function maybeReadTextFile (filePath) {
  let buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch (error) {
    return null
  }

  if (buffer.includes(0)) {
    return null
  }

  try {
    return buffer.toString('utf8')
  } catch (error) {
    return null
  }
}

function loadDeviceFarmMetadata (inputDirs) {
  const metadata = new Map()

  for (const inputDir of inputDirs) {
    for (const filePath of walkFiles(inputDir)) {
      if (path.basename(filePath) !== AUTO_METADATA_FILE) continue

      const raw = maybeReadTextFile(filePath)
      if (!raw) continue

      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue

        try {
          const record = JSON.parse(line)
          if (record.downloadedPath) {
            metadata.set(path.resolve(record.downloadedPath), record)
          }
        } catch (error) {
          console.warn(`Warning: could not parse metadata line in ${filePath}: ${error.message}`)
        }
      }
    }
  }

  return metadata
}

function findMarkerPayloads (filePath) {
  const text = maybeReadTextFile(filePath)
  if (!text || !text.includes(RESULT_MARKER)) {
    return []
  }

  const payloads = []
  const lines = text.split(/\r?\n/)
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber]
    const markerIndex = line.indexOf(RESULT_MARKER)
    if (markerIndex === -1) continue

    const rawPayload = line.slice(markerIndex + RESULT_MARKER.length).trim()
    if (!rawPayload) continue

    try {
      payloads.push({
        sourceFile: filePath,
        lineNumber: lineNumber + 1,
        payload: JSON.parse(rawPayload)
      })
    } catch (error) {
      console.warn(`Warning: could not parse marker in ${filePath}:${lineNumber + 1}: ${error.message}`)
    }
  }

  return payloads
}

function buildFallbackReport (payload) {
  const platform = payload.platform || ''
  const platformName = payload.platformName || (platform ? String(platform).split('-')[0] : '')
  return {
    timestamp: new Date().toISOString(),
    platform,
    platformName,
    arch: payload.arch || '',
    isMobile: true,
    model: {
      type: payload.modelType || 'unknown',
      path: '',
      dirName: ''
    },
    labels: {
      runner: payload.runnerLabel || '',
      device: payload.deviceLabel || '',
      backend: payload.backendHint || '',
      requestedBackend: payload.useGPU ? 'gpu' : 'cpu',
      label: payload.label || ''
    },
    audio: {},
    config: {
      benchmarkRuns: payload.summary && payload.summary.rtf ? payload.summary.rtf.count || 0 : 0,
      useGPU: Boolean(payload.useGPU)
    },
    requested: {
      modelType: payload.modelType || 'unknown',
      useGPU: Boolean(payload.useGPU),
      backendHint: payload.backendHint || '',
      deviceLabel: payload.deviceLabel || '',
      runnerLabel: payload.runnerLabel || ''
    },
    observed: {},
    summary: payload.summary || {},
    runs: []
  }
}

function cloneJson (value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeReport (marker, metadataByFile) {
  const payload = marker.payload || {}
  const metadata = metadataByFile.get(path.resolve(marker.sourceFile)) || null
  const report = payload.report ? cloneJson(payload.report) : buildFallbackReport(payload)

  report.isMobile = true
  report.labels = report.labels || {}
  report.requested = report.requested || {}
  report.model = report.model || { type: payload.modelType || 'unknown' }
  report.summary = report.summary || payload.summary || {}
  report.runs = Array.isArray(report.runs) ? report.runs : []

  if (!report.labels.backend && payload.backendHint) {
    report.labels.backend = payload.backendHint
  }

  if (!report.labels.runner && payload.runnerLabel) {
    report.labels.runner = payload.runnerLabel
  }

  if (!report.labels.device && payload.deviceLabel) {
    report.labels.device = payload.deviceLabel
  }

  if (metadata) {
    if (!report.labels.device) report.labels.device = metadata.deviceName || ''
    if (!report.labels.runner) report.labels.runner = metadata.runLabel || metadata.platform || 'devicefarm'
  }

  report.extraction = {
    sourceFile: marker.sourceFile,
    lineNumber: marker.lineNumber,
    reportPath: payload.reportPath || null,
    deviceFarm: metadata
      ? {
          platform: metadata.platform || '',
          runLabel: metadata.runLabel || '',
          deviceName: metadata.deviceName || '',
          suiteName: metadata.suiteName || '',
          artifactName: metadata.artifactName || '',
          jobResult: metadata.jobResult || ''
        }
      : null
  }

  return report
}

function getReportFingerprint (report) {
  const summary = report.summary || {}
  const rtf = summary.rtf || {}
  return [
    report.platform || '',
    report.model && report.model.type ? report.model.type : '',
    report.requested && report.requested.useGPU ? 'gpu' : 'cpu',
    report.labels && report.labels.backend ? report.labels.backend : '',
    report.labels && report.labels.device ? report.labels.device : '',
    report.labels && report.labels.runner ? report.labels.runner : '',
    report.labels && report.labels.label ? report.labels.label : '',
    rtf.mean !== undefined ? Number(rtf.mean).toFixed(6) : 'na',
    rtf.count !== undefined ? String(rtf.count) : 'na'
  ].join('|')
}

function buildOutputFileName (report) {
  const modelType = report.model && report.model.type ? report.model.type : 'unknown'
  const useGPU = report.requested && report.requested.useGPU
  const backend = report.labels && report.labels.backend ? report.labels.backend : (useGPU ? 'gpu' : 'cpu')
  const device = report.labels && report.labels.device ? report.labels.device : (report.labels && report.labels.runner ? report.labels.runner : 'mobile')
  const label = report.labels && report.labels.label ? report.labels.label : ''
  const parts = [
    'rtf-benchmark',
    sanitizeSegment(report.platform || 'mobile'),
    sanitizeSegment(modelType),
    sanitizeSegment(useGPU ? 'gpu' : 'cpu'),
    sanitizeSegment(backend),
    sanitizeSegment(device)
  ]

  if (label) {
    parts.push(sanitizeSegment(label))
  }

  return `${parts.join('-')}.json`
}

function writeReportFiles (reports, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true })

  const usedPaths = new Set()
  const written = []

  for (const report of reports) {
    const baseName = buildOutputFileName(report)
    let candidate = path.join(outputDir, baseName)
    let suffix = 2

    while (usedPaths.has(candidate) || fs.existsSync(candidate)) {
      candidate = path.join(outputDir, baseName.replace(/\.json$/, `-${suffix}.json`))
      suffix += 1
    }

    fs.writeFileSync(candidate, `${JSON.stringify(report, null, 2)}\n`)
    usedPaths.add(candidate)
    written.push(candidate)
  }

  return written
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const metadataByFile = loadDeviceFarmMetadata(args.inputDirs)
  const allMarkers = []

  for (const inputDir of args.inputDirs) {
    for (const filePath of walkFiles(inputDir)) {
      allMarkers.push(...findMarkerPayloads(filePath))
    }
  }

  const uniqueReports = []
  const seenFingerprints = new Set()
  for (const marker of allMarkers) {
    const report = normalizeReport(marker, metadataByFile)
    const fingerprint = getReportFingerprint(report)
    if (seenFingerprints.has(fingerprint)) continue
    seenFingerprints.add(fingerprint)
    uniqueReports.push(report)
  }

  const writtenPaths = writeReportFiles(uniqueReports, args.outputDir)
  const manifest = {
    generatedAt: new Date().toISOString(),
    inputDirs: args.inputDirs,
    outputDir: args.outputDir,
    markerLinesFound: allMarkers.length,
    reportsWritten: writtenPaths.length,
    reports: writtenPaths.map((filePath, index) => ({
      path: filePath,
      platform: uniqueReports[index].platform || '',
      modelType: uniqueReports[index].model && uniqueReports[index].model.type ? uniqueReports[index].model.type : 'unknown',
      device: uniqueReports[index].labels && uniqueReports[index].labels.device ? uniqueReports[index].labels.device : '',
      backend: uniqueReports[index].labels && uniqueReports[index].labels.backend ? uniqueReports[index].labels.backend : ''
    }))
  }

  fs.mkdirSync(path.dirname(args.manifestPath), { recursive: true })
  fs.writeFileSync(args.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`Found ${allMarkers.length} marker line(s).`)
  console.log(`Wrote ${writtenPaths.length} mobile RTF report file(s) to ${args.outputDir}.`)
  console.log(`Manifest written to ${args.manifestPath}.`)
}

main()
