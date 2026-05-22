'use strict'

const fs = require('fs')
const path = require('path')
const { median, min, max, round, pctDelta } = require('./math')

function tsStamp () {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
}

// Map a logical metric key to whatever the addon / stdout actually
// exposes. The addon's `response.stats` uses uppercase keys (TTFT,
// TPS, ppTPS); host-stderr regex parsing fills in vision-encode timings
// that aren't in the addon stats payload.
function pickMetric (run, key) {
  if (!run || !run.ok) return null
  const sm = run.stdoutMetrics || {}
  const st = run.stats || {}
  switch (key) {
    case 'wallMs': return run.wallMs
    case 'ttftMs': return (st.TTFT != null ? st.TTFT : (sm.promptEvalMs != null ? sm.promptEvalMs : null))
    case 'decodeTps': return (st.TPS != null ? st.TPS : (sm.decodeTps != null ? sm.decodeTps : null))
    case 'ppTps': return (st.ppTPS != null ? st.ppTPS : null)
    case 'visionEncodeMs': return sm.visionEncodeMs != null ? sm.visionEncodeMs : null
    case 'decodeMs': return sm.decodeMs != null ? sm.decodeMs : null
    case 'loadMs': return sm.loadMs != null ? sm.loadMs : null
    case 'generatedTokens': return st.generatedTokens != null ? st.generatedTokens : null
    case 'promptTokens': return st.promptTokens != null ? st.promptTokens : null
    default: return null
  }
}

function aggregateCell (cell) {
  const okRuns = cell.runs.filter((r) => r.ok)
  const fields = ['visionEncodeMs', 'ttftMs', 'decodeTps', 'ppTps', 'decodeMs', 'loadMs', 'wallMs', 'generatedTokens', 'promptTokens']

  const agg = {
    repeats: okRuns.length,
    repeatsTotal: cell.runs.length,
    failures: cell.runs.length - okRuns.length
  }
  for (const f of fields) {
    const vals = okRuns.map((r) => pickMetric(r, f)).filter((v) => v != null)
    agg[`${f}_median`] = round(median(vals), 3)
    agg[`${f}_min`] = round(min(vals), 3)
    agg[`${f}_max`] = round(max(vals), 3)
  }
  // Distinct backendDevice across runs (addon's auto-pick may differ
  // between launches; if it does, we want that visible).
  const actualBackends = new Set(
    okRuns.map((r) => r.stats && r.stats.backendDevice).filter(Boolean)
  )
  agg.actualBackends = Array.from(actualBackends)

  // Accuracy: with temp=0 + seed, all runs should be identical; report
  // run #0 verbatim, plus a median recall as a sanity-check.
  const first = okRuns[0]
  agg.recallScore_median = round(
    median(okRuns.map((r) => r.accuracy && r.accuracy.recallScore).filter((v) => v != null)),
    3
  )
  if (first && first.accuracy) {
    agg.objectsRecalled = first.accuracy.objectsRecalled
    agg.objectsTotal = first.accuracy.objectsTotal
    agg.objectsMissed = first.accuracy.objectsMissed
    agg.extras = first.accuracy.extras
    agg.fullAnswer = first.fullAnswer
  } else {
    agg.objectsRecalled = null
    agg.objectsTotal = null
    agg.objectsMissed = []
    agg.extras = []
    agg.fullAnswer = null
  }
  // Were all measured-run answers identical? Used by the reporter to
  // tag the "Full model answers" block as definitive vs run-#0-only.
  const answers = okRuns.map((r) => r.fullAnswer).filter((a) => a != null)
  agg.answersAreIdentical = answers.length > 1 && answers.every((a) => a === answers[0])
  return agg
}

function buildSummary (cells) {
  return cells.map((cell) => ({
    sourceKey: cell.cell.sourceKey,
    sourceLabel: cell.cell.sourceLabel,
    backend: cell.cell.backend,
    platform: cell.cell.platform,
    arch: cell.cell.arch,
    metrics: aggregateCell(cell),
    errors: cell.errors || [],
    raw: cell
  }))
}

// ASCII-only output: avoids mojibake when results are read on a
// Windows console / IDE pane that decodes as Windows-1252 instead of
// UTF-8. `-` instead of em-dash; no middle dots.
function fmt (v, digits = 1) {
  if (v == null) return '-'
  if (typeof v !== 'number') return String(v)
  return v.toFixed(digits)
}

function fmtDelta (cand, base, digits = 1) {
  const d = pctDelta(cand, base)
  if (d == null) return '-'
  const sign = d >= 0 ? '+' : ''
  return `${sign}${d.toFixed(digits)}%`
}

function renderFullMatrixMarkdown (summary, meta) {
  const lines = []
  lines.push(`# VLM Benchmark - ${meta.modelId}`)
  lines.push('')
  lines.push(`- Image: \`${meta.image}\``)
  lines.push(`- Prompt: \`${meta.prompt}\``)
  lines.push(`- Ground truth (${meta.groundTruthCount} objects): ${meta.groundTruth.join(', ')}`)
  lines.push(`- Runs: ${meta.warmupRuns} warmup + ${meta.measuredRuns} measured, **median** reported`)
  lines.push(`- Thinking mode: ${meta.thinkingEnabled ? 'on (reasoning-budget=-1)' : 'off (reasoning-budget=0)'}`)
  lines.push(`- Generated at: ${meta.generatedAt}`)
  if (meta.hardware) {
    const h = meta.hardware
    lines.push(`- Host: ${h.platform}-${h.arch}, ${h.cpu.model || 'unknown CPU'} (${h.cpu.cores} cores), ${h.ram.totalGb} GB RAM`)
    if (h.gpus && h.gpus.length) {
      const gpuLine = h.gpus.map((g) => `${g.vendor ? g.vendor + ' ' : ''}${g.model || '?'}${g.memoryMb ? ` (${g.memoryMb}MB)` : ''}`).join('; ')
      lines.push(`- GPUs: ${gpuLine}`)
    } else {
      lines.push('- GPUs: none detected')
    }
  }
  lines.push('')

  const byPlatform = new Map()
  for (const s of summary) {
    const k = `${s.platform}-${s.arch}`
    if (!byPlatform.has(k)) byPlatform.set(k, [])
    byPlatform.get(k).push(s)
  }

  for (const [platform, rows] of byPlatform) {
    lines.push(`## ${platform}`)
    lines.push('')
    lines.push('| Backend (requested / actual) | Source | runs | vis-enc (ms) | TTFT (ms) | TPS | wall (ms) | recall | objects | status |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const r of rows) {
      const m = r.metrics
      const hasError = r.errors && r.errors.length > 0
      const status = m.repeats > 0 ? 'OK' : (hasError ? `FAIL: ${r.errors[0].phase}` : 'FAIL')
      const recall = m.recallScore_median != null
        ? `${m.objectsRecalled}/${m.objectsTotal} (${m.recallScore_median.toFixed(2)})`
        : '-'
      const objects = m.repeats === 0
        ? '-'
        : (m.objectsMissed && m.objectsMissed.length ? `missed: ${m.objectsMissed.join(', ')}` : 'all')
      const repeats = m.repeatsTotal != null ? `${m.repeats}/${m.repeatsTotal}` : `${m.repeats}`
      const actual = m.actualBackends && m.actualBackends.length ? m.actualBackends.join(',') : '-'
      const backendCol = `${r.backend} / ${actual}`
      lines.push(`| ${backendCol} | ${r.sourceLabel} | ${repeats} | ${fmt(m.visionEncodeMs_median)} | ${fmt(m.ttftMs_median)} | ${fmt(m.decodeTps_median, 2)} | ${fmt(m.wallMs_median)} | ${recall} | ${objects} | ${status} |`)
    }
    lines.push('')
  }

  // Errors block — surfaces spawn failures etc. that the table compresses
  // into a single "FAIL" cell.
  const errorRows = summary.filter((r) => r.errors && r.errors.length > 0)
  if (errorRows.length > 0) {
    lines.push('## Errors')
    lines.push('')
    for (const r of errorRows) {
      lines.push(`- **${r.platform}-${r.arch} / ${r.backend} / ${r.sourceLabel}**`)
      for (const e of r.errors) {
        lines.push(`  - [${e.phase}] ${e.message}`)
      }
    }
    lines.push('')
  }

  lines.push('## Full model answers')
  lines.push('')
  for (const r of summary) {
    const m = r.metrics
    const repeats = m.repeats || 0
    let tag
    if (repeats === 0) tag = '(no successful runs)'
    else if (repeats === 1) tag = '(single run)'
    else if (m.answersAreIdentical) tag = `(identical across all ${repeats} runs)`
    else tag = `(showing run #0 of ${repeats}; runs differ)`
    lines.push(`### ${r.platform}-${r.arch} / ${r.backend} / ${r.sourceLabel} ${tag}`)
    lines.push('')
    lines.push('```')
    lines.push(m.fullAnswer || '(no answer)')
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

function renderDeltaMarkdown (summary) {
  // Group by (platform, backend); within each group expect candidate +
  // baseline. Emit a candidate-vs-baseline delta.
  const groups = new Map()
  for (const s of summary) {
    const k = `${s.platform}-${s.arch}|${s.backend}`
    if (!groups.has(k)) groups.set(k, {})
    if (s.sourceKey === 'candidate') groups.get(k).candidate = s
    if (s.sourceKey === 'baseline') groups.get(k).baseline = s
  }

  const lines = []
  lines.push('## VLM Benchmark - candidate vs baseline')
  lines.push('')
  lines.push('| Platform | Backend | vis-enc | TTFT | TPS | wall | recall (cand) | recall (base) |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const [k, { candidate, baseline }] of groups) {
    if (!candidate) continue
    const cm = candidate.metrics
    const bm = baseline ? baseline.metrics : {}
    const recallC = cm.recallScore_median != null ? cm.recallScore_median.toFixed(2) : '-'
    const recallB = bm.recallScore_median != null ? bm.recallScore_median.toFixed(2) : '-'
    lines.push(`| ${candidate.platform}-${candidate.arch} | ${candidate.backend} | ${fmtDelta(cm.visionEncodeMs_median, bm.visionEncodeMs_median)} | ${fmtDelta(cm.ttftMs_median, bm.ttftMs_median)} | ${fmtDelta(cm.decodeTps_median, bm.decodeTps_median)} | ${fmtDelta(cm.wallMs_median, bm.wallMs_median)} | ${recallC} | ${recallB} |`)
  }
  lines.push('')
  lines.push('Note: vis-enc / TTFT / wall - negative delta is better. TPS - positive delta is better. Recall is not gated in V1.')
  return lines.join('\n')
}

function writeReports ({ outputDir, summary, meta }) {
  fs.mkdirSync(outputDir, { recursive: true })
  const ts = tsStamp()
  const jsonPath = path.join(outputDir, `vlm-perf-${ts}.json`)
  const matrixPath = path.join(outputDir, `vlm-perf-${ts}.md`)
  const deltaPath = path.join(outputDir, `vlm-perf-${ts}.delta.md`)

  fs.writeFileSync(jsonPath, JSON.stringify({ meta, summary }, null, 2))
  fs.writeFileSync(matrixPath, renderFullMatrixMarkdown(summary, meta))
  fs.writeFileSync(deltaPath, renderDeltaMarkdown(summary))

  return { jsonPath, matrixPath, deltaPath }
}

module.exports = { buildSummary, writeReports, renderFullMatrixMarkdown, renderDeltaMarkdown }
