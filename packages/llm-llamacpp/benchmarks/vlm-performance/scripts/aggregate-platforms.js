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

// Recursively find files matching a predicate. Mobile perf-report
// artifacts arrive several directories deep (one subdir per test
// group), so we can't rely on the shallow walk our own artifacts use.
function findFiles (dir, predicate, depth = 0) {
  const out = []
  if (!fs.existsSync(dir) || depth > 6) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...findFiles(full, predicate, depth + 1))
    } else if (predicate(entry.name, full)) {
      out.push(full)
    }
  }
  return out
}

function loadReportsFrom (dir) {
  const reports = []
  if (!fs.existsSync(dir)) return reports

  // Our own per-platform vlm-perf JSONs.
  const ours = findFiles(dir, (name) => /^vlm-perf-.*\.json$/.test(name) && !name.endsWith('.delta.md'))
  for (const p of ours) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      reports.push({ kind: 'vlm-perf', source: path.relative(dir, path.dirname(p)) || '.', path: p, data })
    } catch (e) {
      console.error(`[aggregate] skipped ${p}: ${e.message}`)
    }
  }

  // Mobile perf-report.json produced by _perf-helper.js (different
  // schema — see packages/llm-llamacpp/test/integration/_perf-helper.js).
  const mobile = findFiles(dir, (name) => name === 'perf-report.json')
  for (const p of mobile) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      // schema_version + results array distinguishes it from ours.
      if (data && Array.isArray(data.results) && data.schema_version) {
        reports.push({ kind: 'mobile-perf', source: path.relative(dir, path.dirname(p)) || '.', path: p, data })
      }
    } catch (e) {
      console.error(`[aggregate] skipped ${p}: ${e.message}`)
    }
  }
  return reports
}

// Convert one mobile perf-report.json into vlm-perf-shaped summary
// entries. The mobile suite emits multiple results per file (image-
// elephant, image-fruit-plate, ...) — we only surface VLM-relevant
// scenarios. Each result becomes one row in the consolidated table.
function mobileReportToSummary (report) {
  const data = report.data
  const deviceName = (data.device && data.device.name) || 'android'
  const out = []
  for (const r of (data.results || [])) {
    // Keep only image-class scenarios so we don't pollute the VLM
    // table with text-only or tool-calling tests from the same suite.
    if (!String(r.scenario || '').toLowerCase().includes('image')) continue
    const metrics = r.metrics || {}
    out.push({
      sourceKey: 'mobile-existing',
      sourceLabel: `mobile/${r.test}`,
      backend: metrics.backend || 'auto',
      platform: deviceName,
      arch: 'mobile',
      metrics: {
        repeats: 1,
        repeatsTotal: 1,
        failures: 0,
        visionEncodeMs_median: metrics.vision_encode_time_ms ?? null,
        ttftMs_median: metrics.ttft_ms ?? null,
        decodeTps_median: metrics.tps ?? null,
        wallMs_median: metrics.total_time_ms ?? null,
        actualBackends: metrics.backend ? [metrics.backend] : [],
        // No recall scoring on the legacy mobile path — explicit null
        // so the consumer can render '-' rather than fabricate a value.
        recallScore_median: null,
        objectsRecalled: null,
        objectsTotal: null,
        objectsMissed: [],
        extras: [],
        fullAnswer: r.output || null,
        answersAreIdentical: true
      },
      errors: []
    })
  }
  return out
}

function renderConsolidatedMarkdown (reports) {
  const lines = []
  if (reports.length === 0) {
    return '# VLM Benchmark - Consolidated\n\nNo per-platform reports were found. Each platform job must upload a `vlm-perf-<TS>.json` artifact for it to appear here.\n'
  }

  // Pick metadata from the first vlm-perf report (mobile reports
  // don't have our meta shape).
  const firstVlm = reports.find((r) => r.kind === 'vlm-perf')
  const firstMeta = (firstVlm && firstVlm.data.meta) || {}
  const hasMobile = reports.some((r) => r.kind === 'mobile-perf')
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

  lines.push('| Platform | Backend (req/actual) | Source | runs | vis-enc (ms) | TTFT (ms) | TPS | wall (ms) | recall | status |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const report of reports) {
    const summary = report.kind === 'mobile-perf'
      ? mobileReportToSummary(report)
      : (report.data.summary || [])
    for (const row of summary) {
      const m = row.metrics || {}
      const hasError = row.errors && row.errors.length > 0
      const status = m.repeats > 0 ? 'OK' : (hasError ? `FAIL: ${row.errors[0].phase}` : 'FAIL')
      const recall = m.recallScore_median != null
        ? `${m.objectsRecalled}/${m.objectsTotal} (${m.recallScore_median.toFixed(2)})`
        : '-'
      const repeats = m.repeatsTotal != null ? `${m.repeats}/${m.repeatsTotal}` : `${m.repeats || 0}`
      const actual = m.actualBackends && m.actualBackends.length ? m.actualBackends.join(',') : '-'
      const backendCol = `${row.backend} / ${actual}`
      lines.push(`| ${row.platform}-${row.arch} | ${backendCol} | ${row.sourceLabel} | ${repeats} | ${fmt(m.visionEncodeMs_median)} | ${fmt(m.ttftMs_median)} | ${fmt(m.decodeTps_median, 2)} | ${fmt(m.wallMs_median)} | ${recall} | ${status} |`)
    }
  }
  lines.push('')

  if (hasMobile) {
    lines.push('> **Mobile row caveat**: rows labelled `mobile/*` come from the existing `integration-mobile-test-llm-llamacpp` workflow in `--perf-only` mode. They use a different image (`elephant.jpg`), a different prompt, and (currently) SmolVLM2-500M instead of Qwen3.5 — the numbers are **not directly comparable** to the desktop VLM rows. Bundling our benchmark into the Android test app is a planned follow-up.')
    lines.push('')
  }

  // Host hardware block — one line per platform with CPU / RAM / GPU
  // so a reviewer can see what hardware the row came from.
  lines.push('## Host hardware')
  lines.push('')
  const seenHosts = new Set()
  for (const report of reports) {
    if (report.kind !== 'vlm-perf') continue
    const h = report.data.meta && report.data.meta.hardware
    if (!h) continue
    const k = `${h.platform}-${h.arch}`
    if (seenHosts.has(k)) continue
    seenHosts.add(k)
    const gpus = (h.gpus || []).map((g) => `${g.vendor ? g.vendor + ' ' : ''}${g.model || '?'}${g.memoryMb ? ` (${g.memoryMb}MB)` : ''}`).join('; ') || 'none detected'
    lines.push(`- **${k}**: ${h.cpu && h.cpu.model ? h.cpu.model : 'unknown CPU'} (${h.cpu ? h.cpu.cores : '?'} cores), ${h.ram ? h.ram.totalGb + ' GB' : '?'} RAM; GPUs: ${gpus}`)
  }
  lines.push('')

  // Cross-platform errors block.
  const errorRows = []
  for (const report of reports) {
    const rows = report.kind === 'mobile-perf'
      ? mobileReportToSummary(report)
      : (report.data.summary || [])
    for (const row of rows) {
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
  lines.push('## Full model answers')
  lines.push('')
  for (const report of reports) {
    const rows = report.kind === 'mobile-perf'
      ? mobileReportToSummary(report)
      : (report.data.summary || [])
    for (const row of rows) {
      const m = row.metrics || {}
      if (!m.fullAnswer) continue
      const repeats = m.repeats || 0
      let tag
      if (repeats === 1) tag = '(single run)'
      else if (m.answersAreIdentical) tag = `(identical across all ${repeats} runs)`
      else tag = `(showing run #0 of ${repeats}; runs differ)`
      lines.push(`### ${row.platform}-${row.arch} / ${row.backend} / ${row.sourceLabel} ${tag}`)
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
    reports: reports.map((r) => ({
      kind: r.kind,
      source: r.source,
      meta: r.data.meta || null,
      summary: r.kind === 'mobile-perf' ? mobileReportToSummary(r) : (r.data.summary || [])
    }))
  }
  fs.mkdirSync(path.dirname(outputJson), { recursive: true })
  fs.writeFileSync(outputJson, JSON.stringify(merged, null, 2))
  console.log(`[aggregate] wrote ${outputJson}`)
}

main()
