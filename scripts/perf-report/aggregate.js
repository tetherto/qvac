#!/usr/bin/env node
'use strict'

/**
 * Performance report aggregation script.
 *
 * Downloads performance-report.json artifacts from GitHub Actions runs,
 * groups by device/test, computes statistics, and outputs both a
 * machine-readable JSON summary and a human-readable Markdown report
 * that mirrors the team's existing Excel spreadsheet format.
 *
 * Usage:
 *   node scripts/perf-report/aggregate.js --addon ocr-onnx --workflow "Integration Tests (OCR)" --runs 6
 *   node scripts/perf-report/aggregate.js --dir ./downloaded-reports
 *   node scripts/perf-report/aggregate.js --help
 */

const fs = require('fs')
const path = require('path')
const { aggregateReports, generateMarkdownReport, generateHtmlReport } = require('./utils')
const {
  listWorkflowRuns,
  downloadRunArtifacts,
  collectReportsFromDir
} = require('./gh-artifacts')

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const args = {
    addon: null,
    addonType: null,
    workflow: null,
    runs: 6,
    dir: null,
    output: null,
    outputJson: null,
    outputHtml: null,
    repo: null,
    // QVAC-17830: split MD vs HTML detail tables. The combined GH
    // step summary has been getting noisy with one detail table per
    // device, so we keep the markdown squashed (Mean ± std rollup
    // only) and let the HTML artifact keep the full breakdown.
    // `--device-details` is preserved as a "both" alias for back-compat
    // with anything that already passes it.
    mdDeviceDetails: false,
    htmlDeviceDetails: false,
    // QVAC-18298: case-insensitive, pipe-separated test-name filter (same
    // convention as extract-from-log.js's --filter).
    filter: null,
    help: false
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--addon': args.addon = argv[++i]; break
      case '--addon-type': args.addonType = argv[++i]; break
      case '--workflow': args.workflow = argv[++i]; break
      case '--runs': args.runs = parseInt(argv[++i], 10); break
      case '--dir': args.dir = argv[++i]; break
      case '--output': args.output = argv[++i]; break
      case '--output-json': args.outputJson = argv[++i]; break
      case '--output-html': args.outputHtml = argv[++i]; break
      case '--repo': args.repo = argv[++i]; break
      case '--filter': args.filter = argv[++i]; break
      case '--device-details':
        args.mdDeviceDetails = true
        args.htmlDeviceDetails = true
        break
      case '--md-device-details': args.mdDeviceDetails = true; break
      case '--html-device-details': args.htmlDeviceDetails = true; break
      case '--help': case '-h': args.help = true; break
    }
  }
  return args
}

function printHelp () {
  console.log(`
Performance Report Aggregator

Downloads performance artifacts from CI and generates comparison reports.

OPTIONS:
  --addon <name>        Addon name to filter artifacts (e.g. ocr-onnx, nmtcpp)
  --addon-type <type>   Addon type for per-device detail tables (default: 'vision')
  --workflow <name>     GitHub Actions workflow name to query
  --runs <n>            Number of recent runs to aggregate (default: 6)
  --dir <path>          Use local directory of JSON reports instead of downloading
  --output <path>       Markdown output file (default: stdout)
  --output-json <path>  JSON summary output file (optional)
  --output-html <path>  HTML report file (optional, self-contained)
  --repo <owner/repo>   GitHub repository (default: current repo)
  --device-details      Append per-device detail tables to BOTH markdown and HTML
                        (alias for --md-device-details + --html-device-details)
  --md-device-details   Append per-device detail tables to the markdown output only
  --html-device-details Append per-device detail tables to the HTML output only
                        (recommended for combined GH step summaries — keeps the
                        markdown squashed to mean ± std while the HTML keeps the
                        full per-device breakdown)
  --filter <pattern>    Pipe-separated, case-insensitive substrings matched
                        against each result's test name. Only matching rows are
                        aggregated (e.g. "gemma4-vl|qwen3.5-vl"). Use to carve a
                        focused section out of a shared addon's artifacts.
  -h, --help            Show this help

EXAMPLES:
  # Aggregate last 6 OCR integration test runs from CI
  node scripts/perf-report/aggregate.js \\
    --addon ocr-onnx \\
    --workflow "Integration Tests (OCR)" \\
    --runs 6 \\
    --output reports/ocr-performance.md

  # Aggregate from a local directory of downloaded reports
  node scripts/perf-report/aggregate.js \\
    --dir ./perf-artifacts \\
    --output reports/comparison.md \\
    --output-json reports/comparison.json
`)
}

// ---------------------------------------------------------------------------
// Report collection (gh + filesystem helpers live in ./gh-artifacts.js)
// ---------------------------------------------------------------------------

function downloadAndCollect (workflow, runs, addon, repo) {
  console.log(`Querying last ${runs} completed runs of "${workflow}"...`)
  const runsList = listWorkflowRuns(workflow, runs, repo)

  if (!runsList.length) {
    console.error('No completed runs found.')
    return []
  }

  console.log(`Found ${runsList.length} runs:`)
  for (const r of runsList) {
    console.log(`  #${r.number} (${r.conclusion}) - ${r.displayTitle}`)
  }

  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'perf-agg-'))
  console.log(`Downloading artifacts to ${tmpDir}...`)

  const artifactPattern = addon ? `perf-report-*` : '*perf*'

  for (const run of runsList) {
    console.log(`  Downloading run #${run.number} (${run.databaseId})...`)
    downloadRunArtifacts(run.databaseId, tmpDir, artifactPattern, repo)
  }

  return collectReportsFromDir(tmpDir)
}

// ---------------------------------------------------------------------------
// Result filtering (QVAC-18298)
// ---------------------------------------------------------------------------

/**
 * Restricts each report's `results` to rows whose `test` name contains one
 * of the pipe-separated, case-insensitive substrings in `pattern`. Reports
 * left with no matching rows are dropped. Returns input unchanged when
 * `pattern` is falsy. Lets perf-report.yml carve a focused section out of
 * a shared addon's artifacts.
 */
function filterReports (reports, pattern) {
  if (!pattern) return reports
  const keywords = pattern
    .split('|')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean)
  if (!keywords.length) return reports

  let kept = 0
  let dropped = 0
  const out = []
  for (const report of reports) {
    const results = (report.results || []).filter(r => {
      const name = (r.test || '').toLowerCase()
      return keywords.some(k => name.includes(k))
    })
    dropped += (report.results || []).length - results.length
    kept += results.length
    if (results.length) out.push(Object.assign({}, report, { results }))
  }
  console.log(`Filter "${pattern}": kept ${kept} row(s), dropped ${dropped}, ${out.length}/${reports.length} report(s) retained`)
  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main () {
  const args = parseArgs(process.argv)

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  let reports

  if (args.dir) {
    console.log(`Loading reports from ${args.dir}...`)
    reports = collectReportsFromDir(args.dir)
  } else if (args.workflow) {
    reports = downloadAndCollect(args.workflow, args.runs, args.addon, args.repo)
  } else {
    console.error('Error: specify either --dir or --workflow')
    printHelp()
    process.exit(1)
  }

  if (!reports.length) {
    console.error('No performance reports found.')
    process.exit(1)
  }

  if (args.filter) {
    reports = filterReports(reports, args.filter)
    if (!reports.length) {
      console.error(`No performance reports left after applying --filter "${args.filter}".`)
      process.exit(1)
    }
  }

  console.log(`\nAggregating ${reports.length} report(s)...`)
  const aggregated = aggregateReports(reports)

  // Infer addon type from first report when caller did not pass one.
  // Per-device detail tables only render for addon types that have an
  // explicit column list (vision today) — `generateDeviceDetailTables`
  // returns '' for other types and the flag is a no-op.
  const resolvedAddonType = args.addonType ||
    (reports[0] && reports[0].addon_type) ||
    'vision'

  const markdown = generateMarkdownReport(aggregated, {
    includeDeviceDetails: args.mdDeviceDetails,
    addonType: resolvedAddonType
  })

  if (args.output) {
    const dir = path.dirname(args.output)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(args.output, markdown)
    console.log(`Markdown report written to ${args.output}`)
  } else {
    console.log('\n' + markdown)
  }

  if (args.outputJson) {
    const dir = path.dirname(args.outputJson)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(args.outputJson, JSON.stringify(aggregated, null, 2) + '\n')
    console.log(`JSON summary written to ${args.outputJson}`)
  }

  if (args.outputHtml) {
    const dir = path.dirname(args.outputHtml)
    fs.mkdirSync(dir, { recursive: true })
    const html = generateHtmlReport(aggregated, {
      includeDeviceDetails: args.htmlDeviceDetails,
      addonType: resolvedAddonType
    })
    fs.writeFileSync(args.outputHtml, html)
    console.log(`HTML report written to ${args.outputHtml}`)
  }

  const deviceCount = Object.keys(aggregated.devices).length
  const testCount = Object.values(aggregated.devices)
    .reduce((sum, tests) => sum + Object.keys(tests).length, 0)
  console.log(`\nDone. ${deviceCount} device(s), ${testCount} test group(s), ${reports.length} run(s).`)
}

main()
