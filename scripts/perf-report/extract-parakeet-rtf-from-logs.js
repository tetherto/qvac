#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const MARKER = 'QVAC_RTF_REPORT::'
const PERF_START = '[PERF_REPORT_START]'
const PERF_END = '[PERF_REPORT_END]'
const CHUNK_RE = /\[PERF_CHUNK:([^:]+):(\d+):(\d+)\](.+)/

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

function cleanLogcatLine (raw) {
  let value = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const isControl = (code <= 31) || (code >= 127 && code <= 159)
    if (!isControl) value += raw[i]
  }
  value = value.trim()
  value = value.replace(/^\[\d+-\d+\]\s*/, '')
  value = value.replace(/\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[VDIWEF]\s+[^\s:]+\s*:\s*/g, '')
  if (/^'\[Bare\]',\s*'/.test(value)) {
    value = value.replace(/^'\[Bare\]',\s*'/, '').replace(/'$/, '')
  }
  return value.trim()
}

function collectReports (logDir) {
  const reports = []
  const files = walk(logDir)
  const chunks = new Map()

  for (const filePath of files) {
    if (/^perf-report(?:-.*)?\.json$/.test(path.basename(filePath))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        parsed.logSource = path.relative(logDir, filePath)
        reports.push(parsed)
      } catch (error) {
        console.error(`Failed to parse benchmark report file ${filePath}: ${error.message}`)
      }
      continue
    }

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

    for (const line of lines) {
      const cleaned = cleanLogcatLine(line)
      const startIdx = cleaned.indexOf(PERF_START)
      const endIdx = cleaned.indexOf(PERF_END)
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const json = cleaned.slice(startIdx + PERF_START.length, endIdx)
        try {
          const parsed = JSON.parse(json)
          parsed.logSource = path.relative(logDir, filePath)
          reports.push(parsed)
        } catch (_) {}
      }

      const match = CHUNK_RE.exec(cleaned)
      if (!match) continue
      const id = match[1]
      const idx = parseInt(match[2], 10)
      const total = parseInt(match[3], 10)
      const fragment = match[4]
      if (!chunks.has(id)) {
        chunks.set(id, { total, parts: [] })
      }
      chunks.get(id).parts[idx] = fragment
    }
  }

  for (const [id, chunk] of chunks.entries()) {
    if (chunk.parts.filter(Boolean).length !== chunk.total) continue
    try {
      const parsed = JSON.parse(chunk.parts.join(''))
      parsed.logSource = `chunk:${id}`
      reports.push(parsed)
    } catch (error) {
      console.error(`Failed to parse chunked benchmark marker ${id}: ${error.message}`)
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
    console.error('Usage: node scripts/perf-report/extract-parakeet-rtf-from-logs.js <input-dir> <output-dir>')
    process.exit(1)
  }

  if (!fs.existsSync(logDir)) {
    console.error(`Log directory not found: ${logDir}`)
    process.exit(1)
  }

  const reports = dedupeReports(collectReports(logDir))
  if (reports.length === 0) {
    console.log('No Parakeet RTF reports found in the input directory.')
    process.exit(0)
  }

  writeReports(reports, outputDir)
  console.log(`Extracted ${reports.length} mobile benchmark report(s).`)
}

main()
