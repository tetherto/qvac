#!/usr/bin/env node
'use strict'

/**
 * Extracts performance report JSON from Device Farm log files.
 *
 * Scans all files in a directory for lines containing:
 *   [PERF_REPORT_START]{...json...}[PERF_REPORT_END]
 *
 * Writes the first valid JSON payload to the specified output path.
 *
 * Usage:
 *   node scripts/perf-report/extract-from-log.js <log-dir> <output-path>
 */

const fs = require('fs')
const path = require('path')

const START_MARKER = '[PERF_REPORT_START]'
const END_MARKER = '[PERF_REPORT_END]'

function extractFromFile (filePath) {
  let content
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (_) {
    return null
  }

  const startIdx = content.indexOf(START_MARKER)
  if (startIdx === -1) return null

  const jsonStart = startIdx + START_MARKER.length
  const endIdx = content.indexOf(END_MARKER, jsonStart)
  if (endIdx === -1) return null

  const jsonStr = content.substring(jsonStart, endIdx)
  try {
    return JSON.parse(jsonStr)
  } catch (err) {
    console.error(`Found markers in ${filePath} but JSON parse failed: ${err.message}`)
    return null
  }
}

function walkDir (dir) {
  const results = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return results
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(full))
    } else {
      results.push(full)
    }
  }
  return results
}

function main () {
  const logDir = process.argv[2]
  const outputPath = process.argv[3]

  if (!logDir || !outputPath) {
    console.error('Usage: node extract-from-log.js <log-dir> <output-path>')
    process.exit(1)
  }

  console.log(`Scanning ${logDir} for performance report markers...`)
  const files = walkDir(logDir)
  console.log(`Found ${files.length} file(s) to scan`)

  for (const file of files) {
    const report = extractFromFile(file)
    if (report) {
      const dir = path.dirname(outputPath)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
      console.log(`Extracted performance report from ${file}`)
      console.log(`Written to ${outputPath} (${report.results ? report.results.length : 0} results)`)
      process.exit(0)
    }
  }

  console.log('No performance report markers found in logs')
  process.exit(0)
}

main()
