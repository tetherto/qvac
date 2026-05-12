#!/usr/bin/env node
'use strict'

/**
 * Extracts performance report JSON from Device Farm log files.
 *
 * Scans all files in a directory for lines containing:
 *   [PERF_REPORT_START]{...json...}[PERF_REPORT_END]
 *
 * Device Farm artifacts are laid out per-device:
 *   <log-dir>/<Device_Name>/TESTSPEC_OUTPUT.txt
 *
 * When multiple devices are found, writes per-device reports:
 *   <output-dir>/<Device_Name>/performance-report.json
 * Each report's device.name is set to the actual device model.
 *
 * When only one device is found, writes to <output-path> directly.
 *
 * Usage:
 *   node scripts/perf-report/extract-from-log.js <log-dir> <output-path> [--run-number N]
 */

const fs = require('fs')
const path = require('path')

const START_MARKER = '[PERF_REPORT_START]'
const END_MARKER = '[PERF_REPORT_END]'
const CHUNK_RE = /\[PERF_CHUNK:([^:]+):(\d+):(\d+)\](.+)/

function isValidReport (obj) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj) &&
    typeof obj.schema_version === 'string' && Array.isArray(obj.results)
}

function cleanJsonFromLogcat (raw) {
  let s = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()

  // Strip WDIO test runner prefix: "[0-0] " or similar
  s = s.replace(/^\[\d+-\d+\]\s*/, '')

  // Strip Android logcat prefixes: "MM-DD HH:MM:SS.mmm PID TID LEVEL TAG  : "
  s = s.replace(/\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[VDIWEF]\s+[^\s:]+\s*:\s*/g, '')

  // Strip ReactNativeJS wrapper: '[Bare]', '...' → ...
  // Only strip trailing ' when the leading wrapper was present
  if (/^'\[Bare\]',\s*'/.test(s)) {
    s = s.replace(/^'\[Bare\]',\s*'/, '').replace(/'$/, '')
    // The ReactNativeJS bridge wraps content in a JS single-quoted string
    // literal, which escapes embedded single quotes as \'. Those are valid
    // JS string escapes but NOT valid JSON escapes — `JSON.parse` bails on
    // strings like "aujourd\\'hui?" with "Bad escaped character". Unescape
    // before parsing. `\\'` (literal `\` + `'`) is the only JS-but-not-JSON
    // escape the bridge produces — `\n`, `\"`, `\\\\` are all shared.
    s = s.replace(/\\'/g, "'")
  }

  return s.trim()
}

function tryParseReport (jsonStr) {
  if (!jsonStr || jsonStr.length === 0) return null
  if (jsonStr[0] !== '{' && jsonStr[0] !== '[') return null
  try {
    const parsed = JSON.parse(jsonStr)
    return isValidReport(parsed) ? parsed : null
  } catch (_) {
    return null
  }
}

/**
 * Scans text for every [PERF_REPORT_START]...[PERF_REPORT_END] marker
 * pair and returns each successfully parsed report as an element of
 * the returned array. The mobile fallback reporter emits a delta
 * (single-row) report per `record()` call so earlier rows survive a
 * later OOM crash; the caller (typically `main()` with `--merge`)
 * must union across all of them.
 */
function extractAllFromText (text) {
  const reports = []
  let searchFrom = 0
  while (true) {
    const startIdx = text.indexOf(START_MARKER, searchFrom)
    if (startIdx === -1) break

    const jsonStart = startIdx + START_MARKER.length
    const endIdx = text.indexOf(END_MARKER, jsonStart)
    if (endIdx === -1) break

    const jsonRaw = text.substring(jsonStart, endIdx)
    const cleaned = cleanJsonFromLogcat(jsonRaw)

    if (cleaned.length > 0 && cleaned[0] !== '{' && cleaned[0] !== '[') {
      searchFrom = endIdx + END_MARKER.length
      continue
    }

    let parsed = tryParseReport(cleaned)

    // If parse fails, the outer START may have captured interleaved
    // logcat lines; try inner START markers closer to the END.
    if (!parsed) {
      let innerFrom = startIdx + 1
      while (!parsed) {
        const innerStart = text.indexOf(START_MARKER, innerFrom)
        if (innerStart === -1 || innerStart >= endIdx) break
        const innerJson = text.substring(innerStart + START_MARKER.length, endIdx)
        const innerCleaned = cleanJsonFromLogcat(innerJson)
        parsed = tryParseReport(innerCleaned)
        innerFrom = innerStart + 1
      }
    }

    if (parsed) {
      reports.push(parsed)
    } else if (cleaned.length > 0 && cleaned[0] === '{') {
      console.error('  Found markers but JSON parse failed (tried outer + inner START positions)')
      try { JSON.parse(cleaned) } catch (err) {
        const posMatch = err.message.match(/position (\d+)/)
        if (posMatch) {
          const pos = parseInt(posMatch[1], 10)
          const w = 60
          const snippet = cleaned.substring(Math.max(0, pos - w), Math.min(cleaned.length, pos + w))
          console.error(`  Error: ${err.message}`)
          console.error(`  Context: ...${snippet}...`)
        }
      }
    }
    searchFrom = endIdx + END_MARKER.length
  }
  return reports
}

/** Legacy single-report API — returns the last parsed report or null. */
function extractFromText (text) {
  const all = extractAllFromText(text)
  return all.length ? all[all.length - 1] : null
}

/**
 * Strips non-printable / non-JSON characters that logcat may inject.
 * Keeps only printable ASCII + valid JSON whitespace + multi-byte UTF-8.
 */
function sanitizeChunkContent (s) {
  return s.replace(/[^\x20-\x7e\u00a0-\uffff]/g, '')
}

/**
 * Extracts chunked performance reports from text.
 *
 * When a report is too large for a single Android logcat line (~4096 bytes),
 * the mobile reporter splits it into numbered chunks:
 *   [PERF_CHUNK:<id>:<index>:<total>]<json-fragment>
 *
 * Each chunk appears twice in logcat (bare + ReactNativeJS tags).
 * We keep the longest content per (id, index) to guard against truncation,
 * reassemble, clean, and parse.
 * Returns the report with the most results, or null.
 */
function extractChunkedFromText (text) {
  const chunkMap = {}
  const lines = text.split('\n')
  for (const line of lines) {
    const cleaned = cleanJsonFromLogcat(line)
    const m = cleaned.match(CHUNK_RE)
    if (!m) continue
    const [, id, idxStr, totalStr, content] = m
    const idx = parseInt(idxStr, 10)
    const total = parseInt(totalStr, 10)
    if (!chunkMap[id]) chunkMap[id] = { total, chunks: {} }
    if (chunkMap[id].chunks[idx] === undefined || content.length > chunkMap[id].chunks[idx].length) {
      chunkMap[id].chunks[idx] = content
    }
  }

  let best = null
  for (const id of Object.keys(chunkMap)) {
    const { total, chunks } = chunkMap[id]
    const keys = Object.keys(chunks)
    if (keys.length !== total) {
      console.log(`  Chunked report ${id}: got ${keys.length}/${total} chunks (incomplete)`)
      continue
    }
    let json = ''
    for (let i = 0; i < total; i++) json += chunks[i]

    let parsed = tryParseReport(json)

    if (!parsed) {
      const sanitized = sanitizeChunkContent(json)
      if (sanitized !== json) {
        console.log(`  Chunked report ${id}: sanitized ${json.length - sanitized.length} non-printable chars`)
        parsed = tryParseReport(sanitized)
        if (parsed) json = sanitized
      }
    }

    if (!parsed) {
      const firstBrace = json.indexOf('{')
      const lastBrace = json.lastIndexOf('}')
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const trimmed = json.substring(firstBrace, lastBrace + 1)
        parsed = tryParseReport(trimmed)
        if (parsed) {
          console.log(`  Chunked report ${id}: recovered by trimming to brace boundaries`)
          json = trimmed
        }
      }
    }

    if (parsed) {
      console.log(`  Chunked report ${id}: ${parsed.results.length} results`)
      if (!best || parsed.results.length >= best.results.length) best = parsed
    } else {
      console.log(`  Chunked report ${id}: all ${total} chunks collected but JSON parse failed`)
      try { JSON.parse(json) } catch (err) {
        console.log(`    Error: ${err.message}`)
        console.log(`    Assembled length: ${json.length}`)
        console.log(`    First 200: ${JSON.stringify(json.substring(0, 200))}`)
        console.log(`    Last 200: ${JSON.stringify(json.substring(json.length - 200))}`)
        const chunkLens = []
        for (let i = 0; i < total; i++) chunkLens.push(chunks[i].length)
        console.log(`    Chunk lengths: [${chunkLens.join(',')}]`)
      }
    }
  }
  return best
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

function extractAllFromJsonLogcat (content) {
  let entries
  try {
    entries = JSON.parse(content)
  } catch (_) {
    return []
  }
  if (!Array.isArray(entries)) return []
  const messages = entries
    .map(e => (e && e.message) || '')
    .filter(m => m.includes(START_MARKER))
  if (messages.length === 0) return []
  return extractAllFromText(messages.join('\n'))
}

/**
 * When `opts.all` is true, returns every report found in the file
 * (delta-per-record emits plus any chunked final emits). Otherwise
 * returns the best single report (legacy behaviour).
 */
function extractFromFile (filePath, opts) {
  let content
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (_) {
    return opts && opts.all ? [] : null
  }

  if (opts && opts.all) {
    const textReports = extractAllFromText(content)
    const chunked = extractChunkedFromText(content)
    const jsonLogcatReports = textReports.length === 0
      ? extractAllFromJsonLogcat(content)
      : []
    const out = textReports.slice()
    if (chunked) out.push(chunked)
    out.push(...jsonLogcatReports)
    return out
  }

  const markerReport = extractFromText(content)
  const chunkedReport = extractChunkedFromText(content)

  let report = null
  if (markerReport && chunkedReport) {
    report = chunkedReport.results.length >= markerReport.results.length
      ? chunkedReport
      : markerReport
  } else {
    report = chunkedReport || markerReport
  }
  if (report) return report

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

/**
 * Derives the Device Farm device name from a file path relative to logDir.
 *
 * Two layouts are supported:
 *   1. Nested:  <logDir>/<Device_Name>/TESTSPEC_OUTPUT.txt
 *      — returns the first path segment with underscores replaced by spaces.
 *   2. Flat:    <logDir>/<Device_Name>_Tests_Suite_*.txt
 *      — returns the filename prefix before the first Device-Farm phase
 *        separator (Tests_Suite | Setup_Suite | Teardown_Suite | job).
 *
 * Returns null if neither layout matches (caller falls back to 'unknown').
 */
function deriveDeviceName (filePath, logDir) {
  const rel = path.relative(logDir, filePath)
  const firstSeg = rel.split(path.sep)[0]
  if (firstSeg && firstSeg !== path.basename(filePath)) {
    return _stripRunPrefix(firstSeg.replace(/_/g, ' '))
  }
  // Flat layout: extract "Apple_iPhone_16_Pro" from
  // "Apple_iPhone_16_Pro_Tests_Suite_Test_spec_output.txt".
  const base = path.basename(filePath)
  const m = base.match(/^(.+?)_(?:Tests_Suite|Setup_Suite|Teardown_Suite|job)_/)
  if (m && m[1]) return _stripRunPrefix(m[1].replace(/_/g, ' '))
  return null
}

/**
 * Device Farm run names produced by schedule-test-run follow:
 *   (Manual|PR)-<n>-(Android|iOS)[-<suffix>]*
 * where <suffix> is sharding (-Perf, -Regular, -Bench) or dual-flagship
 * (-Samsung, -Pixel, -iPhone17). The refactored collect-and-upload-logs
 * composite groups artifacts under "<RUN>_<DEVICE>" so multiple Device
 * Farm runs targeting the same device pool don't collide on disk. Once
 * the joining underscore is converted back to a space, the first space
 * marks the boundary between run name and device name.
 *
 * Older mobile workflows on main kept artifacts under just the device
 * name, so the combined report's column headers read cleanly. Strip the
 * canonical run prefix here so the new layout produces the same labels.
 *
 * Non-matching inputs are returned unchanged.
 */
function _stripRunPrefix (name) {
  if (!name) return name
  return name.replace(
    /^(?:Manual|PR)-\d+-(?:Android|iOS)(?:-[A-Za-z0-9]+)*\s+/,
    ''
  )
}

function parseArgs () {
  const args = {
    logDir: null,
    outputPath: null,
    runNumber: null,
    filter: null,
    merge: false
  }
  const positional = []
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--run-number' && i + 1 < process.argv.length) {
      args.runNumber = parseInt(process.argv[++i], 10) || null
    } else if (process.argv[i] === '--filter' && i + 1 < process.argv.length) {
      args.filter = process.argv[++i]
    } else if (process.argv[i] === '--merge') {
      args.merge = true
    } else {
      positional.push(process.argv[i])
    }
  }
  args.logDir = positional[0] || null
  args.outputPath = positional[1] || null
  return args
}

/**
 * Concatenates `results` from every report found for a given device
 * into one report. Used when a single physical device runs multiple
 * Device Farm groups (e.g. QVAC-17830 splits the LLM image test into
 * three per-image groups on Android / iOS). The default behaviour of
 * keeping only the largest report would drop two of the three groups.
 *
 * Deduping by `(test, output, metrics snapshot)` keeps the reporter's
 * repeated lightweight flushes from inflating the row count — those
 * flushes emit cumulative snapshots, so the same (test, iteration)
 * can appear in many payloads from one group.
 */
function mergeDeviceReports (reports) {
  if (!reports || reports.length === 0) return null
  const base = JSON.parse(JSON.stringify(reports[0]))
  base.results = []
  const seen = new Set()
  for (const r of reports) {
    if (!r || !Array.isArray(r.results)) continue
    for (const row of r.results) {
      // Perf reporter re-emits cumulative snapshots, so the same row
      // typically appears in many payloads. Dedupe on a stable
      // fingerprint that ignores the output text (may be trimmed in
      // lightweight emits) and focuses on the measured metrics.
      const m = row.metrics || {}
      const key = [
        row.test || '',
        row.execution_provider || '',
        m.total_time_ms != null ? m.total_time_ms : '',
        m.prefill_time_ms != null ? m.prefill_time_ms : '',
        m.decode_time_ms != null ? m.decode_time_ms : '',
        m.generated_tokens != null ? m.generated_tokens : '',
        m.tps != null ? m.tps : ''
      ].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      base.results.push(row)
    }
  }
  return base
}

function filterResults (report, pattern) {
  if (!pattern) return
  const keywords = pattern.split('|').map(k => k.trim().toLowerCase()).filter(Boolean)
  if (!keywords.length) return
  const before = report.results.length
  report.results = report.results.filter(r => {
    const name = (r.test || '').toLowerCase()
    return keywords.some(k => name.includes(k))
  })
  const after = report.results.length
  if (before !== after) {
    console.log(`  Filtered results: ${before} → ${after} (pattern: ${pattern})`)
  }
}

function injectCIMetadata (report, runNumber) {
  if (runNumber && !report.run_number) {
    report.run_number = runNumber
  }
}

function main () {
  const { logDir, outputPath, runNumber, filter, merge } = parseArgs()

  if (!logDir || !outputPath) {
    console.error('Usage: node extract-from-log.js <log-dir> <output-path> [--run-number N] [--filter PATTERN] [--merge]')
    process.exit(1)
  }

  console.log(`Scanning ${logDir} for performance report markers...`)
  const files = walkDir(logDir)
  console.log(`Found ${files.length} file(s) to scan:`)
  for (const f of files) {
    const size = fs.statSync(f).size
    console.log(`  ${f} (${size} bytes)`)
  }

  // When `merge` is on, collect every valid report per device and
  // concatenate at the end. When off, keep only the largest per
  // device (original behaviour — matches OCR pre-QVAC-17830).
  const deviceReports = {}

  for (const file of files) {
    const key = deriveDeviceName(file, logDir) || 'unknown'

    if (merge) {
      // Delta emits: each record() call produces a one-row report, so
      // scooping every marker is required — the largest one alone
      // only carries the final iteration.
      const reports = extractFromFile(file, { all: true }).filter(r => r && Array.isArray(r.results))
      if (reports.length === 0) continue
      const totalRows = reports.reduce((n, r) => n + r.results.length, 0)
      console.log(`  ${file}: found ${reports.length} report(s) with ${totalRows} total row(s) (device: ${key})`)
      if (!deviceReports[key]) deviceReports[key] = { reports: [], files: [], deviceName: key }
      deviceReports[key].reports.push(...reports)
      deviceReports[key].files.push(file)
    } else {
      const report = extractFromFile(file)
      if (!report || !report.results) continue
      const count = report.results.length
      console.log(`  ${file}: found report with ${count} results (device: ${key})`)
      const prev = deviceReports[key]
      if (!prev || count > prev.report.results.length) {
        deviceReports[key] = { report, file, deviceName: key }
      }
    }
  }

  const devices = Object.keys(deviceReports)
  if (devices.length === 0) {
    console.log('No performance report markers found in logs')
    process.exit(0)
  }

  // After merging, collapse each device's [reports] list into a
  // single concatenated report so the rest of the pipeline is
  // identical regardless of --merge.
  if (merge) {
    for (const key of devices) {
      const bucket = deviceReports[key]
      const merged = mergeDeviceReports(bucket.reports)
      if (merged && merged.device) merged.device.name = key
      console.log(
        `  merged ${key}: ${bucket.reports.length} reports from ${bucket.files.length} files ` +
        `→ ${merged ? merged.results.length : 0} deduped results`
      )
      deviceReports[key] = { report: merged, file: bucket.files.join(','), deviceName: key }
    }
  }

  const outputDir = path.dirname(outputPath)

  if (devices.length === 1) {
    const { report, file } = deviceReports[devices[0]]
    if (report.device) report.device.name = devices[0]
    injectCIMetadata(report, runNumber)
    filterResults(report, filter)
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
    console.log(`Extracted performance report from ${file}`)
    console.log(`Written to ${outputPath} (${report.results.length} results)`)
  } else {
    console.log(`Found reports for ${devices.length} devices: ${devices.join(', ')}`)
    for (const key of devices) {
      const { report, file } = deviceReports[key]
      if (report.device) report.device.name = key
      injectCIMetadata(report, runNumber)
      filterResults(report, filter)
      const deviceDir = path.join(outputDir, key.replace(/ /g, '_'))
      fs.mkdirSync(deviceDir, { recursive: true })
      const deviceOutput = path.join(deviceDir, 'performance-report.json')
      fs.writeFileSync(deviceOutput, JSON.stringify(report, null, 2) + '\n')
      console.log(`  ${key}: ${report.results.length} results from ${file} → ${deviceOutput}`)
    }
  }

  console.log('Done.')
  process.exit(0)
}

main()
