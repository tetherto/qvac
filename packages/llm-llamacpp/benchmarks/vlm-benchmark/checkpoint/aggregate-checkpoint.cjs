#!/usr/bin/env node
'use strict'
// Aggregate N VLM-benchmark combine-report markdown files into a CHECKPOINT:
// two per-model tables (Qwen3.5-0.8B, Gemma-4-E2B) of avg ± deviation% across the
// runs, per Platform · Accelerator, with an env header each.
//
// Usage:
//   node aggregate-checkpoint.cjs [--date YYYY-MM-DD] report-1.md report-2.md report-3.md
//
// Inputs are the markdown reports emitted by the `matrix-combine` job of the
// "Benchmark VLM (model comparison)" workflow (see collect-reports.sh to fetch them
// from run IDs). Read-only: touches no benchmark files, runs no models.
//
// Metrics per Platform · Accel:
//   mmproj-enc (ms)  desktop vision-encode time      (mobile shows —; use TTFT there)
//   TTFT (ms)        mobile time-to-first-token       (desktop shows —)
//   full inf (ms)    wall clock per inference
//   cognitive %      VQA Overall % (higher better)
//   OCR %            avg BLEU × 100 (higher better)
//
// Value = avg ± deviation% (deviation = sample stdev / mean). Annotations:
//   †     avg skewed by a one-run outlier (usually self-hosted desktop-CPU runner
//         contention) — the MEDIAN is shown instead as the representative value.
//   (nX)  fewer than N samples for that cell (e.g. a dropped mobile marker row).

const fs = require('fs')

// Fixed model catalog (quant provenance for the env header). Keys are the report
// column labels emitted by config.cjs; keep in sync if the catalog changes.
const MODELS = [
  { key: 'qwen3.5-q8', name: 'Qwen3.5-0.8B', llm: 'Q8_0', mmproj: 'Q8_0' },
  { key: 'gemma4-q4', name: 'Gemma-4-E2B', llm: 'Q4_K_M', mmproj: 'Q8_0' }
]
// Platform display order (desktop first, then mobile). Unknown platforms are appended.
const PLAT_ORDER = ['linux', 'macos', 'macmini', 'windows', 's26', 's25', 'pixel9', 'iphone16', 'iphone17', 'iphone17pro']

const args = process.argv.slice(2)
let date = new Date().toISOString().slice(0, 10)
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date') { date = args[++i] } else { files.push(args[i]) }
}
if (!files.length) { console.error('usage: node aggregate-checkpoint.cjs [--date YYYY-MM-DD] <report.md> ...'); process.exit(1) }

const data = {} // data[`${model}|${plat}|${accel}`][metric] = [values]
const platforms = new Set()
let addon = null
function put (model, plat, accel, metric, val) {
  if (!isFinite(val)) return
  const k = `${model}|${plat}|${accel}`
  data[k] = data[k] || {}
  ;(data[k][metric] = data[k][metric] || []).push(val)
  platforms.add(plat)
}

for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8')
  if (!addon) { const a = txt.match(/@qvac\/llm-llamacpp@([\w.-]+)/); if (a) addon = a[1] }
  for (const ln of txt.split('\n')) {
    if (ln[0] !== '|') continue
    const c = ln.split('|').slice(1, -1).map(x => x.trim())
    const m = c[0] && c[0].match(/^`(.+?)` · (CPU|GPU)$/)
    // Speed Details: `model` · ACCEL | host | n | err | mmproj | tiles | TTFT | encTPS | decTPS | gen | wall
    if (m && c.length === 11 && /^\d+$/.test(c[2]) && /^\d+$/.test(c[3])) {
      const [, model, accel] = m; const host = c[1]
      if (c[4] !== '—' && c[4] !== '') put(model, host, accel, 'mmproj', parseFloat(c[4]))
      else put(model, host, accel, 'ttft', parseFloat(c[6]))
      put(model, host, accel, 'wall', parseFloat(c[10]))
      continue
    }
    // Quality (%) detail: `model` · ACCEL | host | t1..tN | **overall**
    if (m && c.length >= 3 && /\*\*/.test(c[c.length - 1])) {
      const [, model, accel] = m
      put(model, c[1], accel, 'cog', parseFloat(c[c.length - 1].replace(/\*/g, '')))
      continue
    }
    // OCR avg highlight: platform · ACCEL | BLEU ↑ | qwen | gemma | Δ | Δ%
    const om = c[0] && c[0].match(/^([\w.]+) · (CPU|GPU)$/)
    if (om && c[1] && c[1].includes('BLEU')) {
      put('qwen3.5-q8', om[1], om[2], 'ocr', parseFloat(c[2]) * 100)
      put('gemma4-q4', om[1], om[2], 'ocr', parseFloat(c[3]) * 100)
    }
  }
}

function agg (arr) {
  if (!arr || !arr.length) return null
  const n = arr.length; const mean = arr.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n > 1 ? n - 1 : 1))
  const s = arr.slice().sort((a, b) => a - b)
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
  return { mean, median, devpct: mean ? sd / mean * 100 : 0, n }
}
function cell (a, dp, nRuns) {
  if (!a) return '—'
  const hi = a.devpct > 25
  const val = hi ? a.median : a.mean
  return `${val.toFixed(dp)}${hi ? ' †' : ''} ±${a.devpct.toFixed(0)}%${a.n < nRuns ? ` (n${a.n})` : ''}`
}
// Sample count per cell: the normal checkpoint is one value per (model,plat,accel) per
// run, so the max cell count = the number of contributing runs. Flag cells with fewer
// (a dropped mobile marker row) rather than every cell when reports were collected in
// batches (e.g. platforms split across separate runs).
let maxN = 1
for (const k in data) for (const met in data[k]) maxN = Math.max(maxN, data[k][met].length)
const orderedPlats = [...platforms].sort((a, b) => {
  const ia = PLAT_ORDER.indexOf(a); const ib = PLAT_ORDER.indexOf(b)
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
})

const out = []
out.push(`<!-- Checkpoint generated by aggregate-checkpoint.cjs from ${files.length} run(s) -->`)
for (const md of MODELS) {
  out.push('')
  out.push(`## ${md.name}`)
  out.push(`**LLM \`${md.llm}\` · mmproj \`${md.mmproj}\` · addon \`@qvac/llm-llamacpp@${addon || '?'}\` · preset \`full\` · n=${maxN} runs · ${date}**`)
  out.push('')
  out.push('| Platform · Accel | mmproj-enc (ms) | TTFT (ms) | Full inf (ms) | Cognitive % | OCR % |')
  out.push('|---|--:|--:|--:|--:|--:|')
  for (const plat of orderedPlats) {
    for (const accel of ['CPU', 'GPU']) {
      const d = data[`${md.key}|${plat}|${accel}`]; if (!d) continue
      out.push(`| ${plat} · ${accel} | ${cell(agg(d.mmproj), 0, maxN)} | ${cell(agg(d.ttft), 0, maxN)} | ${cell(agg(d.wall), 0, maxN)} | ${cell(agg(d.cog), 1, maxN)} | ${cell(agg(d.ocr), 1, maxN)} |`)
    }
  }
}
out.push('')
out.push('> Value = avg ± deviation% (stdev/mean across runs). `mmproj-enc` = desktop only; `TTFT` = mobile only. ' +
  '`†` = median shown (avg skewed by a one-run runner-contention outlier). `(nX)` = fewer than the full run count for that cell. ' +
  'Cognitive % = VQA Overall; OCR % = avg BLEU×100.')
console.log(out.join('\n'))
