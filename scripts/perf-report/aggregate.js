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
const { execSync } = require('child_process')
const { aggregateReports, generateMarkdownReport, generateHtmlReport } = require('./utils')

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const args = {
    addon: null,
    workflow: null,
    runs: 6,
    dir: null,
    output: null,
    outputJson: null,
    outputHtml: null,
    repo: null,
    help: false
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--addon': args.addon = argv[++i]; break
      case '--workflow': args.workflow = argv[++i]; break
      case '--runs': args.runs = parseInt(argv[++i], 10); break
      case '--dir': args.dir = argv[++i]; break
      case '--output': args.output = argv[++i]; break
      case '--output-json': args.outputJson = argv[++i]; break
      case '--output-html': args.outputHtml = argv[++i]; break
      case '--repo': args.repo = argv[++i]; break
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
  --workflow <name>     GitHub Actions workflow name to query
  --runs <n>            Number of recent runs to aggregate (default: 6)
  --dir <path>          Use local directory of JSON reports instead of downloading
  --output <path>       Markdown output file (default: stdout)
  --output-json <path>  JSON summary output file (optional)
  --output-html <path>  HTML report file (optional, self-contained)
  --repo <owner/repo>   GitHub repository (default: current repo)
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
// GitHub artifact download helpers
// ---------------------------------------------------------------------------

function ghExec (cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    console.error(`gh command failed: ${cmd}`)
    console.error(err.stderr || err.message)
    return ''
  }
}

function listWorkflowRuns (workflow, count, repo) {
  const repoFlag = repo ? ` -R ${repo}` : ''
  const json = ghExec(
    `gh run list --workflow "${workflow}" --status completed --limit ${count} --json databaseId,displayTitle,conclusion,number${repoFlag}`
  )
  if (!json) return []
  try { return JSON.parse(json) } catch (_) { return [] }
}

function downloadRunArtifacts (runId, destDir, artifactPattern, repo) {
  const repoFlag = repo ? ` -R ${repo}` : ''
  const patternFlag = artifactPattern ? ` -p "${artifactPattern}"` : ''
  const runDir = path.join(destDir, String(runId))
  fs.mkdirSync(runDir, { recursive: true })
  ghExec(`gh run download ${runId} -D "${runDir}"${patternFlag}${repoFlag}`)
  return runDir
}

// ---------------------------------------------------------------------------
// Report collection
// ---------------------------------------------------------------------------

function collectReportsFromDir (dir) {
  const reports = []

  function walk (d) {
    const entries = fs.readdirSync(d, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === 'performance-report.json') {
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf-8'))
          reports.push(data)
        } catch (err) {
          console.error(`  skipping ${full}: ${err.message}`)
        }
      }
    }
  }

  walk(dir)
  return reports
}

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

  console.log(`\nAggregating ${reports.length} report(s)...`)
  const aggregated = aggregateReports(reports)

  const markdown = generateMarkdownReport(aggregated)

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
    const html = generateHtmlReport(aggregated)
    fs.writeFileSync(args.outputHtml, html)
    console.log(`HTML report written to ${args.outputHtml}`)
  }

  const deviceCount = Object.keys(aggregated.devices).length
  const testCount = Object.values(aggregated.devices)
    .reduce((sum, tests) => sum + Object.keys(tests).length, 0)
  console.log(`\nDone. ${deviceCount} device(s), ${testCount} test group(s), ${reports.length} run(s).`)
}

main()
