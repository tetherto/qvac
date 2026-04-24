#!/usr/bin/env node
'use strict'

/**
 * Renders a single performance-report.json into a GitHub Step Summary
 * markdown table that mirrors the desktop reporter's writeStepSummary()
 * output — a single compact table per run, not the multi-device
 * comparison layout produced by aggregate.js.
 *
 * This is used by the mobile integration workflow so that the mobile
 * Step Summary matches the desktop integration Step Summary format:
 *
 *   ### Performance: <addon>
 *   > Device: **<name>** (<platform>/<arch>) | Run: <n> | <timestamp>
 *
 *   | Test | EP | Total Time (ms) | Decode (ms) | Tokens | TPS | chrF++ |
 *   | ---  | -- | ---             | ---         | ---    | --- | ---    |
 *   | [Bergamot] [CPU] | cpu | 28 | 28 | 7 | 249.62 | 97.0% |
 *   ...
 *
 * Usage:
 *   node scripts/perf-report/render-step-summary.js <report.json> [output-path]
 *
 * Arguments:
 *   <report.json>   Path to the perf-report.json produced by the inline
 *                   mobile reporter (contains a single device's results).
 *   [output-path]   Optional. File to append the markdown to. Defaults to
 *                   $GITHUB_STEP_SUMMARY. If neither is set, writes to
 *                   stdout so the script is usable locally for debugging.
 *
 * Flags:
 *   --title "<heading>"   Override the top-level H3 (defaults to
 *                         "Performance: <addon>").
 *   --subtitle "<text>"   Override the device/run blockquote line.
 */

const fs = require('fs')
const path = require('path')
const { METRIC_COLUMNS, QUALITY_COLUMNS } = require('../test-utils/performance-reporter')

function parseArgs (argv) {
  const out = { report: null, output: null, title: null, subtitle: null }
  const positional = []
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--title' && i + 1 < argv.length) out.title = argv[++i]
    else if (a === '--subtitle' && i + 1 < argv.length) out.subtitle = argv[++i]
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else positional.push(a)
  }
  out.report = positional[0] || null
  out.output = positional[1] || null
  return out
}

function printHelp () {
  console.log(`Usage: render-step-summary.js <report.json> [output-path] [--title T] [--subtitle S]

Reads a single-device perf-report.json and writes a GitHub-Actions-style
Step Summary markdown block with the desktop reporter's column layout.`)
}

function fmtMetric (col, value) {
  if (value === null || value === undefined) return '-'
  if (col.format === 'percent' && typeof value === 'number') {
    return (value * 100).toFixed(1) + '%'
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  return String(value)
}

function fmtQuality (value) {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'number') return (value * 100).toFixed(1) + '%'
  return String(value)
}

function renderMarkdown (report, opts) {
  const addon = report.addon || 'unknown'
  const addonType = report.addon_type || 'generic'
  const device = report.device || { name: 'unknown', platform: 'unknown', arch: '' }
  const runNumber = report.run_number || 'local'
  const timestamp = report.timestamp || ''
  const results = report.results || []

  const cols = METRIC_COLUMNS[addonType] || METRIC_COLUMNS.generic
  const qCols = QUALITY_COLUMNS[addonType] || []

  const title = (opts && opts.title) || `Performance: ${addon}`
  const subtitle = (opts && opts.subtitle) ||
    `Device: **${device.name}** (${device.platform}/${device.arch}) | Run: ${runNumber} | ${timestamp}`

  const lines = []
  lines.push(`### ${title}`)
  lines.push('')
  lines.push(`> ${subtitle}`)
  lines.push('')

  const header = ['Test', 'EP', ...cols.map(c => c.label)]
  lines.push('| ' + header.join(' | ') + ' |')
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |')

  for (const r of results) {
    const ep = r.execution_provider || '-'
    const cells = [r.test || '-', ep]
    for (const c of cols) cells.push(fmtMetric(c, (r.metrics || {})[c.key]))
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  lines.push('')

  // Only emit a quality section if there are quality columns defined for
  // this addon_type AND the report contains quality values that are NOT
  // already shown in the metric columns. For translation, chrF++ lives
  // in metrics, so we skip an otherwise-empty quality table.
  const metricKeys = new Set(cols.map(c => c.key))
  const uniqueQCols = qCols.filter(c => !metricKeys.has(c.key))
  const qualityResults = results.filter(r => r.quality)
  if (uniqueQCols.length > 0 && qualityResults.length > 0) {
    lines.push(`### Quality: ${addon}`)
    lines.push('')
    const qHeader = ['Test', ...uniqueQCols.map(c => c.label)]
    lines.push('| ' + qHeader.join(' | ') + ' |')
    lines.push('| ' + qHeader.map(() => '---').join(' | ') + ' |')
    for (const r of qualityResults) {
      const cells = [r.test || '-']
      for (const c of uniqueQCols) cells.push(fmtQuality(r.quality[c.key]))
      lines.push('| ' + cells.join(' | ') + ' |')
    }
    lines.push('')
  }

  return lines.join('\n') + '\n'
}

function main () {
  const args = parseArgs(process.argv)
  if (!args.report) {
    console.error('error: missing <report.json> argument')
    printHelp()
    process.exit(1)
  }
  const reportPath = path.resolve(args.report)
  if (!fs.existsSync(reportPath)) {
    console.error(`error: report not found: ${reportPath}`)
    process.exit(1)
  }

  let report
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch (err) {
    console.error(`error: failed to parse ${reportPath}: ${err.message}`)
    process.exit(1)
  }

  const markdown = renderMarkdown(report, { title: args.title, subtitle: args.subtitle })
  const outputPath = args.output || process.env.GITHUB_STEP_SUMMARY || null

  if (!outputPath) {
    process.stdout.write(markdown)
    return
  }

  try {
    fs.appendFileSync(outputPath, markdown)
    console.log(`Wrote Step Summary to ${outputPath} (${(report.results || []).length} rows)`)
  } catch (err) {
    console.error(`error: failed to write ${outputPath}: ${err.message}`)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
} else {
  module.exports = { renderMarkdown }
}
