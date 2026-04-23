#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

function parseArgs (argv) {
  const args = {
    dirs: [],
    desktopDirs: [],
    mobileDirs: [],
    manualDirs: [],
    output: '',
    outputJson: '',
    outputHtml: ''
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--dir') {
      args.dirs.push(path.resolve(argv[++i]))
      continue
    }

    if (arg === '--desktop-dir') {
      args.desktopDirs.push(path.resolve(argv[++i]))
      continue
    }

    if (arg === '--mobile-dir') {
      args.mobileDirs.push(path.resolve(argv[++i]))
      continue
    }

    if (arg === '--manual-dir') {
      args.manualDirs.push(path.resolve(argv[++i]))
      continue
    }

    if (arg === '--output') {
      args.output = path.resolve(argv[++i])
      continue
    }

    if (arg === '--output-json') {
      args.outputJson = path.resolve(argv[++i])
      continue
    }

    if (arg === '--output-html') {
      args.outputHtml = path.resolve(argv[++i])
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!args.output && !args.outputJson && !args.outputHtml) {
    throw new Error('At least one output path is required')
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

function ensureTrailingNewline (text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function isBenchmarkReport (value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.summary &&
    value.summary.rtf &&
    value.model &&
    (value.model.type || (value.requested && value.requested.modelType))
  )
}

function matchesPrefix (filePath, prefixes) {
  return prefixes.some(prefix => filePath === prefix || filePath.startsWith(`${prefix}${path.sep}`))
}

function collectReportsFromDir (targetDir) {
  return walkFiles(targetDir)
    .filter(filePath => filePath.endsWith('.json'))
    .map(filePath => {
      try {
        const report = readJson(filePath)
        if (!isBenchmarkReport(report)) return null
        return { filePath, report }
      } catch (error) {
        console.warn(`Warning: could not read ${filePath}: ${error.message}`)
        return null
      }
    })
    .filter(Boolean)
}

function classifySource (filePath, report, args) {
  if (matchesPrefix(filePath, args.manualDirs)) return 'manual'
  if (matchesPrefix(filePath, args.mobileDirs)) return 'mobile'
  if (matchesPrefix(filePath, args.desktopDirs)) return 'desktop'
  if (report.isMobile) return 'mobile'
  if (report.labels && report.labels.runner === 'manual') return 'manual'
  return 'desktop'
}

function normalizeReportEntry (entry, args) {
  const report = entry.report
  const rtf = report.summary && report.summary.rtf ? report.summary.rtf : {}
  const wallMs = report.summary && report.summary.wallMs ? report.summary.wallMs : {}
  const tokensPerSecond = report.summary && report.summary.tokensPerSecond ? report.summary.tokensPerSecond : {}
  const source = classifySource(entry.filePath, report, args)
  const modelType = report.model && report.model.type
    ? report.model.type
    : (report.requested && report.requested.modelType ? report.requested.modelType : 'unknown')
  const useGPU = report.requested && report.requested.useGPU !== undefined
    ? Boolean(report.requested.useGPU)
    : Boolean(report.config && report.config.useGPU)

  return {
    source,
    filePath: entry.filePath,
    timestamp: report.timestamp || '',
    platform: report.platform || '',
    platformName: report.platformName || '',
    arch: report.arch || '',
    isMobile: Boolean(report.isMobile || source === 'mobile'),
    modelType,
    useGPU,
    backend: report.labels && report.labels.backend ? report.labels.backend : '',
    device: report.labels && report.labels.device ? report.labels.device : '',
    runner: report.labels && report.labels.runner ? report.labels.runner : '',
    label: report.labels && report.labels.label ? report.labels.label : '',
    meanRtf: rtf.mean !== undefined ? Number(rtf.mean) : null,
    p50Rtf: rtf.p50 !== undefined ? Number(rtf.p50) : null,
    p95Rtf: rtf.p95 !== undefined ? Number(rtf.p95) : null,
    runCount: rtf.count !== undefined ? Number(rtf.count) : (Array.isArray(report.runs) ? report.runs.length : 0),
    meanWallMs: wallMs.mean !== undefined ? Number(wallMs.mean) : null,
    meanTokensPerSecond: tokensPerSecond.mean !== undefined ? Number(tokensPerSecond.mean) : null,
    raw: report
  }
}

function compareEntries (left, right) {
  const leftKey = [
    left.source,
    left.platform,
    left.device,
    left.modelType,
    left.backend,
    left.useGPU ? 'gpu' : 'cpu',
    left.label
  ].join('|')
  const rightKey = [
    right.source,
    right.platform,
    right.device,
    right.modelType,
    right.backend,
    right.useGPU ? 'gpu' : 'cpu',
    right.label
  ].join('|')
  return leftKey.localeCompare(rightKey)
}

function buildSummary (normalized) {
  const counts = {
    total: normalized.length,
    desktop: normalized.filter(item => item.source === 'desktop').length,
    mobile: normalized.filter(item => item.source === 'mobile').length,
    manual: normalized.filter(item => item.source === 'manual').length
  }

  const platforms = [...new Set(normalized.map(item => item.platform).filter(Boolean))].sort()

  return {
    generatedAt: new Date().toISOString(),
    counts,
    platforms
  }
}

function formatNumber (value, digits) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits)
}

function buildMarkdown (normalized, summary) {
  const lines = [
    '# Parakeet Unified RTF Report',
    '',
    `Generated: ${summary.generatedAt}`,
    '',
    `Artifacts processed: ${summary.counts.total} total (${summary.counts.desktop} desktop, ${summary.counts.mobile} mobile, ${summary.counts.manual} manual).`
  ]

  if (summary.platforms.length > 0) {
    lines.push('')
    lines.push(`Platforms: ${summary.platforms.join(', ')}`)
  }

  lines.push('')

  if (normalized.length === 0) {
    lines.push('No benchmark artifacts were found.')
    return ensureTrailingNewline(lines.join('\n'))
  }

  lines.push('| Source | Platform | Device | Model | Backend | GPU | Mean RTF | P50 | P95 | Tokens/s | Runs |')
  lines.push('|--------|----------|--------|-------|---------|-----|----------|-----|-----|----------|------|')

  for (const item of normalized) {
    lines.push([
      '|',
      item.source,
      '|',
      item.platform || 'n/a',
      '|',
      item.device || item.runner || 'n/a',
      '|',
      item.modelType,
      '|',
      item.backend || 'n/a',
      '|',
      item.useGPU ? 'yes' : 'no',
      '|',
      formatNumber(item.meanRtf, 4),
      '|',
      formatNumber(item.p50Rtf, 4),
      '|',
      formatNumber(item.p95Rtf, 4),
      '|',
      formatNumber(item.meanTokensPerSecond, 1),
      '|',
      item.runCount || 0,
      '|'
    ].join(' '))
  }

  lines.push('')
  return ensureTrailingNewline(lines.join('\n'))
}

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildHtml (normalized, summary) {
  const rows = normalized.map(item => [
    `<td>${escapeHtml(item.source)}</td>`,
    `<td>${escapeHtml(item.platform || 'n/a')}</td>`,
    `<td>${escapeHtml(item.device || item.runner || 'n/a')}</td>`,
    `<td>${escapeHtml(item.modelType)}</td>`,
    `<td>${escapeHtml(item.backend || 'n/a')}</td>`,
    `<td>${item.useGPU ? 'yes' : 'no'}</td>`,
    `<td>${escapeHtml(formatNumber(item.meanRtf, 4))}</td>`,
    `<td>${escapeHtml(formatNumber(item.p50Rtf, 4))}</td>`,
    `<td>${escapeHtml(formatNumber(item.p95Rtf, 4))}</td>`,
    `<td>${escapeHtml(formatNumber(item.meanTokensPerSecond, 1))}</td>`,
    `<td>${escapeHtml(String(item.runCount || 0))}</td>`
  ].join('')).join('</tr>\n<tr>')

  const body = normalized.length === 0
    ? '<p>No benchmark artifacts were found.</p>'
    : `
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Platform</th>
            <th>Device</th>
            <th>Model</th>
            <th>Backend</th>
            <th>GPU</th>
            <th>Mean RTF</th>
            <th>P50</th>
            <th>P95</th>
            <th>Tokens/s</th>
            <th>Runs</th>
          </tr>
        </thead>
        <tbody>
          <tr>${rows}</tr>
        </tbody>
      </table>
    `

  return ensureTrailingNewline(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Parakeet Unified RTF Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #1f2937; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; }
    th { background: #f3f4f6; }
    .meta { color: #4b5563; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Parakeet Unified RTF Report</h1>
  <p class="meta">Generated: ${escapeHtml(summary.generatedAt)}</p>
  <p class="meta">Artifacts processed: ${summary.counts.total} total (${summary.counts.desktop} desktop, ${summary.counts.mobile} mobile, ${summary.counts.manual} manual).</p>
  ${body}
</body>
</html>
`)
}

function writeFileIfRequested (filePath, contents) {
  if (!filePath) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function aggregateReports (args) {
  const sourceDirs = [
    ...args.dirs,
    ...args.desktopDirs,
    ...args.mobileDirs,
    ...args.manualDirs
  ]

  const uniqueDirs = [...new Set(sourceDirs)]
  const reports = uniqueDirs.flatMap(collectReportsFromDir)
  const normalized = reports.map(entry => normalizeReportEntry(entry, args)).sort(compareEntries)
  const summary = buildSummary(normalized)
  const outputJson = {
    generatedAt: summary.generatedAt,
    counts: summary.counts,
    platforms: summary.platforms,
    reports: normalized.map(item => ({
      source: item.source,
      filePath: item.filePath,
      timestamp: item.timestamp,
      platform: item.platform,
      platformName: item.platformName,
      arch: item.arch,
      isMobile: item.isMobile,
      modelType: item.modelType,
      useGPU: item.useGPU,
      backend: item.backend,
      device: item.device,
      runner: item.runner,
      label: item.label,
      meanRtf: item.meanRtf,
      p50Rtf: item.p50Rtf,
      p95Rtf: item.p95Rtf,
      runCount: item.runCount,
      meanWallMs: item.meanWallMs,
      meanTokensPerSecond: item.meanTokensPerSecond
    }))
  }

  return {
    markdown: buildMarkdown(normalized, summary),
    json: `${JSON.stringify(outputJson, null, 2)}\n`,
    html: buildHtml(normalized, summary),
    summary
  }
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const outputs = aggregateReports(args)

  writeFileIfRequested(args.output, outputs.markdown)
  writeFileIfRequested(args.outputJson, outputs.json)
  writeFileIfRequested(args.outputHtml, outputs.html)

  console.log(`Aggregated ${outputs.summary.counts.total} report(s).`)
  console.log(`Desktop: ${outputs.summary.counts.desktop}`)
  console.log(`Mobile: ${outputs.summary.counts.mobile}`)
  console.log(`Manual: ${outputs.summary.counts.manual}`)
}

if (require.main === module) {
  main()
}

module.exports = {
  aggregateReports,
  main
}
