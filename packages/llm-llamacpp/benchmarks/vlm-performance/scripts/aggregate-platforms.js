#!/usr/bin/env node
'use strict'

// Cross-platform aggregator for the CI summarize step.
//
// Takes a directory of per-platform vlm-perf JSON outputs (one
// `vlm-perf-<TS>.json` per platform, downloaded as artifacts) and emits
// a single consolidated Markdown report plus a merged JSON.
//
// Usage:
//   node aggregate-platforms.js --inputs <dir> --output-md <path> --output-json <path>

const fs = require('fs')
const path = require('path')

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq !== -1) { out[t.slice(2, eq)] = t.slice(eq + 1); continue }
    const k = t.slice(2)
    const n = argv[i + 1]
    if (!n || n.startsWith('--')) { out[k] = true } else { out[k] = n; i++ }
  }
  return out
}

function fmt (v, digits = 1) {
  if (v == null) return '-'
  if (typeof v !== 'number') return String(v)
  return v.toFixed(digits)
}

function loadReportsFrom (dir) {
  const reports = []
  if (!fs.existsSync(dir)) return reports

  // Walk one level deep — actions/download-artifact deposits each
  // artifact under its own subdirectory.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const file of fs.readdirSync(path.join(dir, entry.name))) {
        if (/vlm-perf-.*\.json$/.test(file) && !file.endsWith('.delta.md')) {
          const fullPath = path.join(dir, entry.name, file)
          try {
            const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
            reports.push({ source: entry.name, path: fullPath, data })
          } catch (e) {
            console.error(`[aggregate] skipped ${fullPath}: ${e.message}`)
          }
        }
      }
    } else if (/vlm-perf-.*\.json$/.test(entry.name)) {
      const fullPath = path.join(dir, entry.name)
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
        reports.push({ source: '.', path: fullPath, data })
      } catch (e) {
        console.error(`[aggregate] skipped ${fullPath}: ${e.message}`)
      }
    }
  }
  return reports
}

function renderConsolidatedMarkdown (reports) {
  const lines = []
  if (reports.length === 0) {
    return '# VLM Benchmark - Consolidated\n\nNo per-platform reports were found. Each platform job must upload a `vlm-perf-<TS>.json` artifact for it to appear here.\n'
  }

  // Pick metadata from the first report — they should all share the
  // same model / image / prompt / ground truth in V1 (one cell).
  const firstMeta = reports[0].data.meta || {}
  lines.push(`# VLM Benchmark - Consolidated`)
  lines.push('')
  lines.push(`- Model: \`${firstMeta.modelId || 'unknown'}\``)
  lines.push(`- Image: \`${firstMeta.image || 'unknown'}\``)
  lines.push(`- Prompt: \`${firstMeta.prompt || 'unknown'}\``)
  if (firstMeta.groundTruth) {
    lines.push(`- Ground truth (${firstMeta.groundTruthCount} objects): ${firstMeta.groundTruth.join(', ')}`)
  }
  lines.push(`- Runs: ${firstMeta.warmupRuns} warmup + ${firstMeta.measuredRuns} measured, **median** reported`)
  if (firstMeta.thinkingEnabled != null) {
    lines.push(`- Thinking mode: ${firstMeta.thinkingEnabled ? 'on' : 'off'}`)
  }
  lines.push('')

  lines.push('| Platform | Backend | Source | vis-enc (ms) | TTFT (ms) | TPS | wall (ms) | recall | status |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const report of reports) {
    const summary = report.data.summary || []
    for (const row of summary) {
      const m = row.metrics || {}
      const hasError = row.errors && row.errors.length > 0
      const status = m.repeats > 0 ? 'OK' : (hasError ? `FAIL: ${row.errors[0].phase}` : 'FAIL')
      const recall = m.recallScore_median != null
        ? `${m.objectsRecalled}/${m.objectsTotal} (${m.recallScore_median.toFixed(2)})`
        : '-'
      lines.push(`| ${row.platform}-${row.arch} | ${row.backend} | ${row.sourceLabel} | ${fmt(m.visionEncodeMs_median)} | ${fmt(m.ttftMs_median)} | ${fmt(m.decodeTps_median, 2)} | ${fmt(m.wallMs_median)} | ${recall} | ${status} |`)
    }
  }
  lines.push('')

  // Cross-platform errors block.
  const errorRows = []
  for (const report of reports) {
    for (const row of (report.data.summary || [])) {
      if (row.errors && row.errors.length > 0) errorRows.push(row)
    }
  }
  if (errorRows.length > 0) {
    lines.push('## Errors')
    lines.push('')
    for (const row of errorRows) {
      lines.push(`- **${row.platform}-${row.arch} / ${row.backend} / ${row.sourceLabel}**`)
      for (const e of row.errors) {
        const truncatedMsg = String(e.message || '').split('\n').slice(0, 3).join(' | ')
        lines.push(`  - [${e.phase}] ${truncatedMsg}`)
      }
    }
    lines.push('')
  }

  // Per-platform full model answers.
  lines.push('## Full model answers (run #0 per cell)')
  lines.push('')
  for (const report of reports) {
    for (const row of (report.data.summary || [])) {
      const m = row.metrics || {}
      if (!m.fullAnswer) continue
      lines.push(`### ${row.platform}-${row.arch} / ${row.backend} / ${row.sourceLabel}`)
      lines.push('')
      lines.push('```')
      lines.push(m.fullAnswer)
      lines.push('```')
      lines.push('')
    }
  }

  return lines.join('\n')
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const inputs = args.inputs ? path.resolve(args.inputs) : path.resolve('inputs')
  const outputMd = args['output-md'] ? path.resolve(args['output-md']) : path.resolve('vlm-perf-consolidated.md')
  const outputJson = args['output-json'] ? path.resolve(args['output-json']) : path.resolve('vlm-perf-consolidated.json')

  const reports = loadReportsFrom(inputs)
  console.log(`[aggregate] loaded ${reports.length} per-platform report(s) from ${inputs}`)

  const md = renderConsolidatedMarkdown(reports)
  fs.mkdirSync(path.dirname(outputMd), { recursive: true })
  fs.writeFileSync(outputMd, md)
  console.log(`[aggregate] wrote ${outputMd}`)

  const merged = {
    generatedAt: new Date().toISOString(),
    platformCount: reports.length,
    reports: reports.map((r) => ({ source: r.source, meta: r.data.meta, summary: r.data.summary }))
  }
  fs.mkdirSync(path.dirname(outputJson), { recursive: true })
  fs.writeFileSync(outputJson, JSON.stringify(merged, null, 2))
  console.log(`[aggregate] wrote ${outputJson}`)
}

main()
