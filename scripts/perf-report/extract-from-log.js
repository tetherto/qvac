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

/**
 * Extracts markers from plain text content.
 * Returns the last valid report found.
 */
function isValidReport (obj) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj) &&
    typeof obj.schema_version === 'string' && Array.isArray(obj.results)
}

function extractFromText (text) {
  let lastReport = null
  let searchFrom = 0
  while (true) {
    const startIdx = text.indexOf(START_MARKER, searchFrom)
    if (startIdx === -1) break

    const jsonStart = startIdx + START_MARKER.length
    const endIdx = text.indexOf(END_MARKER, jsonStart)
    if (endIdx === -1) break

    const jsonStr = text.substring(jsonStart, endIdx)
    try {
      const parsed = JSON.parse(jsonStr)
      if (isValidReport(parsed)) {
        lastReport = parsed
      } else {
        console.error('  Found markers but payload is not a valid report object (missing schema_version/results)')
      }
    } catch (err) {
      console.error(`  Found markers but JSON parse failed: ${err.message}`)
    }
    searchFrom = endIdx + END_MARKER.length
  }
  return lastReport
}

/**
 * Device Farm logcat files are JSON arrays where each entry has a `message`
 * field containing the app's console.log output. We extract all messages
 * and search them as plain text.
 */
function extractFromJsonLogcat (content) {
  let entries
  try {
    entries = JSON.parse(content)
  } catch (_) {
    return null
  }
  if (!Array.isArray(entries)) return null

  const messages = entries
    .map(e => (e && e.message) || '')
    .filter(m => m.includes(START_MARKER))
  if (messages.length === 0) return null

  console.log(`  Found ${messages.length} log entries with perf markers`)
  return extractFromText(messages.join('\n'))
}

function extractFromFile (filePath) {
  let content
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (_) {
    return null
  }

  // Try plain text first (test spec output, plain logcat)
  let report = extractFromText(content)
  if (report) return report

  // Try JSON logcat format (Device Farm DEVICE_LOG / LOGCAT artifacts)
  report = extractFromJsonLogcat(content)
  if (report) return report

  return null
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
