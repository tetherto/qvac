#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const MARKER = 'QVAC_RTF_REPORT::'

function walk (dir) {
  const files = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else {
      files.push(fullPath)
    }
  }

  return files
}

function safeName (value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function collectReports (logDir) {
  const reports = []
  const files = walk(logDir)

  for (const filePath of files) {
    let content
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch (_) {
      continue
    }

    const lines = content.split('\n')
    for (const line of lines) {
      const markerIndex = line.indexOf(MARKER)
      if (markerIndex === -1) continue

      const payload = line.slice(markerIndex + MARKER.length).trim()
      try {
        const parsed = JSON.parse(payload)
        parsed.logSource = path.relative(logDir, filePath)
        reports.push(parsed)
      } catch (error) {
        console.error(`Failed to parse benchmark marker in ${filePath}: ${error.message}`)
      }
    }
  }

  return reports
}

function dedupeReports (reports) {
  const byKey = new Map()

  for (const report of reports) {
    const key = [
      report.platform || '',
      report.modelType || '',
      report.useGPU ? 'gpu' : 'cpu',
      report.deviceLabel || '',
      report.runnerLabel || '',
      report.backendHint || ''
    ].join('::')

    if (!byKey.has(key)) {
      byKey.set(key, report)
    }
  }

  return [...byKey.values()]
}

function writeReports (reports, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true })

  for (const report of reports) {
    const fileName = [
      'rtf-benchmark',
      safeName(report.platform || 'unknown-platform'),
      safeName(report.modelType || 'unknown-model'),
      report.useGPU ? 'gpu' : 'cpu',
      safeName(report.deviceLabel || report.runnerLabel || report.backendHint || 'mobile')
    ].join('-') + '.json'

    const outputPath = path.join(outputDir, fileName)
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
    console.log(`Wrote ${outputPath}`)
  }
}

function main () {
  const logDir = process.argv[2]
  const outputDir = process.argv[3]

  if (!logDir || !outputDir) {
    console.error('Usage: node scripts/perf-report/extract-parakeet-rtf-from-logs.js <log-dir> <output-dir>')
    process.exit(1)
  }

  if (!fs.existsSync(logDir)) {
    console.error(`Log directory not found: ${logDir}`)
    process.exit(1)
  }

  const reports = dedupeReports(collectReports(logDir))
  if (reports.length === 0) {
    console.log('No Parakeet RTF reports found in logs.')
    process.exit(0)
  }

  writeReports(reports, outputDir)
  console.log(`Extracted ${reports.length} mobile benchmark report(s).`)
}

main()
