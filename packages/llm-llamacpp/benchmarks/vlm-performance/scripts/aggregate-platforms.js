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

// Inlined from ../math.js so this script stays self-contained — the
// summarize job uses sparse-checkout that only pulls the scripts/
// directory; reaching into the parent dir means widening the
// sparse-checkout, which has its own breakage risk.
function pctDelta (candidate, baseline) {
  if (candidate == null || baseline == null || baseline === 0) return null
  return ((candidate - baseline) / baseline) * 100
}

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

  // Our own per-platform vlm-perf JSONs. (Mobile perf-report
  // ingestion was tried and reverted — see workflow comments.)
  const ours = findFiles(dir, (name) => /^vlm-perf-.*\.json$/.test(name) && !name.endsWith('.delta.md'))
  for (const p of ours) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      reports.push({ kind: 'vlm-perf', source: path.relative(dir, path.dirname(p)) || '.', path: p, data })
    } catch (e) {
      console.error(`[aggregate] skipped ${p}: ${e.message}`)
    }
  }
  return reports
}

function summaryOf (report) {
  return (report.data && report.data.summary) || []
}

// Returns "better" / "worse" / "same" given a candidate vs baseline
// metric value. `lowerIsBetter` flips the sign so wall-time and TPS
// produce the right verdict. A ±noiseBand window is treated as "same"
// because runner variability + median-of-3 doesn't reliably resolve
// sub-2% changes on GitHub-hosted runners.
const NOISE_BAND_PCT = 2

function verdictFor (candidate, baseline, lowerIsBetter) {
  const d = pctDelta(candidate, baseline)
  if (d == null) return { delta: null, label: '-' }
  if (Math.abs(d) <= NOISE_BAND_PCT) return { delta: d, label: 'same' }
  const better = lowerIsBetter ? d < 0 : d > 0
  return { delta: d, label: better ? 'better' : 'worse' }
}

function fmtDelta (d) {
  if (d == null) return '-'
  const sign = d >= 0 ? '+' : ''
  return `${sign}${d.toFixed(1)}%`
}

// Walks every (platform, backend) bucket and emits a verdict table
// per metric when both `candidate` and `baseline` rows are present.
// Returns null when no comparable pair exists — caller can skip the
// block entirely.
function renderVerdictBlock (reports) {
  const groups = new Map()
  for (const report of reports) {
    for (const row of summaryOf(report)) {
      const k = `${row.platform}-${row.arch}|${row.backend}`
      if (!groups.has(k)) groups.set(k, {})
      const sk = String(row.sourceKey || '').toLowerCase()
      // Match strictly on sourceKey ('candidate' / 'baseline' from
      // source-resolver.js) — earlier attempt to also match by label
      // pattern accidentally treated 'addon@candidate' as a baseline
      // because 'c' is a hex character.
      if (sk === 'candidate') groups.get(k).candidate = row
      else if (sk === 'baseline') groups.get(k).baseline = row
    }
  }
  const pairs = []
  for (const [k, v] of groups) {
    if (v.candidate && v.baseline) pairs.push({ k, c: v.candidate, b: v.baseline })
  }
  if (pairs.length === 0) return null

  const lines = []
  lines.push('## Verdict (candidate vs baseline)')
  lines.push('')
  lines.push(`Noise band: any change within ±${NOISE_BAND_PCT}% is reported as "same" — runner variability + median-of-3 doesn't reliably resolve smaller deltas on GitHub-hosted runners.`)
  lines.push('')
  lines.push('| Platform / Backend | vis-enc | TTFT | TPS | wall | recall |')
  lines.push('|---|---|---|---|---|---|')
  for (const { c, b } of pairs) {
    const cm = c.metrics || {}; const bm = b.metrics || {}
    const v_vis = verdictFor(cm.visionEncodeMs_median, bm.visionEncodeMs_median, true)
    const v_ttft = verdictFor(cm.ttftMs_median, bm.ttftMs_median, true)
    const v_tps = verdictFor(cm.decodeTps_median, bm.decodeTps_median, false)
    const v_wall = verdictFor(cm.wallMs_median, bm.wallMs_median, true)
    // Recall is exact-match for now: same recall = same; otherwise
    // worse if candidate recalls fewer, better if more.
    let recallVerdict = 'same'
    if (cm.recallScore_median != null && bm.recallScore_median != null) {
      if (cm.recallScore_median > bm.recallScore_median) recallVerdict = 'better'
      else if (cm.recallScore_median < bm.recallScore_median) recallVerdict = 'worse'
    }
    const cell = (v) => `${fmtDelta(v.delta)} ${v.label}`
    lines.push(`| ${c.platform}-${c.arch} / ${c.backend} | ${cell(v_vis)} | ${cell(v_ttft)} | ${cell(v_tps)} | ${cell(v_wall)} | ${cm.objectsRecalled ?? '-'}/${cm.objectsTotal ?? '-'} vs ${bm.objectsRecalled ?? '-'}/${bm.objectsTotal ?? '-'} - ${recallVerdict} |`)
  }
  lines.push('')

  // Sanity check: are the two refs the same npm version? When yes, the
  // benchmark exercised the SAME prebuilds twice, and the verdict above
  // is just measurement noise. Surface that explicitly so reviewers
  // don't celebrate a non-comparison.
  const sameVersions = pairs.every(({ c, b }) => {
    const cLabel = String(c.sourceLabel || '')
    const bLabel = String(b.sourceLabel || '')
    return cLabel === bLabel
  })
  if (sameVersions) {
    lines.push('> **Warning**: candidate and baseline resolved to the same addon source. The numbers above are noise, not a real comparison. This usually means the branch did not bump `packages/llm-llamacpp/package.json#version` between the merge-base and HEAD. A true source-level compare requires building the addon at both commits (planned follow-up).')
    lines.push('')
  }
  return lines.join('\n')
}

// Pull the modelSources from the first vlm-perf meta (they're the
// same across platforms in V1 — every leg downloads from the same
// URL set). Renders both candidate and baseline as a small table.
function renderModelProvenance (reports) {
  const firstVlm = reports.find((r) => r.kind === 'vlm-perf')
  if (!firstVlm) return null
  const sources = firstVlm.data && firstVlm.data.meta && firstVlm.data.meta.modelSources
  if (!sources || sources.length === 0) return null

  const lines = []
  lines.push('## Model provenance')
  lines.push('')
  lines.push('Exactly which GGUF blobs produced the rows above. SHA-256 + byte size make the rows reproducible if you re-download from the same URL.')
  lines.push('')
  lines.push('| Source | Repo @ revision | Quant | LLM URL | LLM size | LLM SHA-256 | mmproj size | mmproj SHA-256 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const s of sources) {
    const llm = (s.provenance && s.provenance.llm) || {}
    const mm = (s.provenance && s.provenance.mmproj) || {}
    const repoCell = s.hfRepo
      ? `\`${s.hfRepo}\`<br/>@\`${(s.hfRevision || '?').slice(0, 8)}\``
      : '-'
    const url = llm.url ? llm.url.replace(/.*\//, '') : '-'
    const llmSize = llm.sizeMb != null ? `${llm.sizeMb} MB` : '-'
    const mmSize = mm.sizeMb != null ? `${mm.sizeMb} MB` : '-'
    const llmHash = llm.sha256 ? `\`${llm.sha256.slice(0, 12)}…\`` : '-'
    const mmHash = mm.sha256 ? `\`${mm.sha256.slice(0, 12)}…\`` : '-'
    lines.push(`| **${s.label}** | ${repoCell} | ${s.quant || '-'} | \`${url}\` | ${llmSize} | ${llmHash} | ${mmSize} | ${mmHash} |`)
  }
  lines.push('')
  // If the verdict block exists and the two sources have IDENTICAL
  // LLM hashes, the verdict numbers above are noise — call that out.
  if (sources.length === 2) {
    const cand = sources.find((s) => s.key === 'candidate')
    const base = sources.find((s) => s.key === 'baseline')
    const candHash = cand && cand.provenance && cand.provenance.llm && cand.provenance.llm.sha256
    const baseHash = base && base.provenance && base.provenance.llm && base.provenance.llm.sha256
    if (candHash && baseHash && candHash === baseHash) {
      lines.push('> **Heads-up**: candidate and baseline LLM blobs have **identical SHA-256** — they\'re the same file, so any perf delta in the verdict above is measurement noise.')
      lines.push('')
    }
  }
  return lines.join('\n')
}

function renderSoftwareProvenance (reports) {
  const firstVlm = reports.find((r) => r.kind === 'vlm-perf')
  if (!firstVlm) return null
  const sw = firstVlm.data && firstVlm.data.meta && firstVlm.data.meta.software
  if (!sw) return null

  const lines = []
  lines.push('## Software provenance')
  lines.push('')
  const addon = sw.addon || {}
  const bare = sw.bare || {}
  const git = sw.git || {}
  lines.push(`- **Addon**: \`${addon.name || '?'}@${addon.version || '?'}\``)
  if (addon.prebuildFile) {
    lines.push(`  - Prebuild: \`${addon.prebuildFile.replace(/.*[\\/]prebuilds[\\/]/, 'prebuilds/')}\` (${addon.prebuildSizeMb || '?'} MB)`)
  }
  lines.push(`- **Bare runtime**: \`${bare.version || '?'}\` (source: ${bare.source || '?'})`)
  lines.push(`- **Node.js**: \`${sw.node || '?'}\``)
  if (git.sha) {
    lines.push(`- **Benchmark commit**: \`${git.shortSha}\` on \`${git.branch || '?'}\` - ${git.title || '?'} (${git.date || '?'})`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderConsolidatedMarkdown (reports, commitInfo) {
  const lines = []
  if (reports.length === 0) {
    return '# VLM Benchmark - Consolidated\n\nNo per-platform reports were found. Each platform job must upload a `vlm-perf-<TS>.json` artifact for it to appear here.\n'
  }

  const firstVlm = reports.find((r) => r.kind === 'vlm-perf')
  const firstMeta = (firstVlm && firstVlm.data.meta) || {}
  lines.push(`# VLM Benchmark - Consolidated`)
  lines.push('')

  // Commit context — what two refs are we comparing?
  if (commitInfo) {
    lines.push('## Commits under test')
    lines.push('')
    if (commitInfo.head && commitInfo.head.sha) {
      const sha = commitInfo.head.sha.slice(0, 8)
      lines.push(`- **HEAD**: \`${sha}\` - ${commitInfo.head.title || '(no title)'} (${commitInfo.head.date || '?'})`)
    }
    if (commitInfo.merge_base && commitInfo.merge_base.sha) {
      const sha = commitInfo.merge_base.sha.slice(0, 8)
      lines.push(`- **Merge-base with main**: \`${sha}\` - ${commitInfo.merge_base.title || '(no title)'} (${commitInfo.merge_base.date || '?'})`)
    }
    if (commitInfo.compare_baseline_requested) {
      lines.push('')
      lines.push('Baseline comparison was requested. Verdict block appears below the platform tables once both `addon@candidate` and `addon@<sha>` rows are present.')
    } else {
      lines.push('')
      lines.push('Baseline comparison was NOT requested for this run. Enable `compare_baseline` on the next dispatch to get a side-by-side delta table.')
    }
    lines.push('')
  }

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
    const summary = summaryOf(report)
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

  // ── Verdict block ───────────────────────────────────────────────
  // When the candidate-vs-baseline comparison was actually exercised,
  // emit a per-(platform, backend) delta table with a verdict label.
  const verdictBlock = renderVerdictBlock(reports)
  if (verdictBlock) {
    lines.push(verdictBlock)
  }

  // Model provenance — exact source the candidate / baseline rows
  // came from. SHA-256 + byte size + URL lets a reviewer trace which
  // blob each row used.
  const modelBlock = renderModelProvenance(reports)
  if (modelBlock) {
    lines.push(modelBlock)
  }

  // Software provenance — addon version, prebuild file, bare version,
  // git info. Same purpose as model provenance, but for the runtime.
  const softwareBlock = renderSoftwareProvenance(reports)
  if (softwareBlock) {
    lines.push(softwareBlock)
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
    for (const row of summaryOf(report)) {
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
    const rows = summaryOf(report)
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

  let commitInfo = null
  if (args['commit-info']) {
    try {
      commitInfo = JSON.parse(fs.readFileSync(path.resolve(args['commit-info']), 'utf8'))
    } catch (e) {
      console.error(`[aggregate] could not read commit-info: ${e.message}`)
    }
  }

  const reports = loadReportsFrom(inputs)
  console.log(`[aggregate] loaded ${reports.length} per-platform report(s) from ${inputs}`)

  const md = renderConsolidatedMarkdown(reports, commitInfo)
  fs.mkdirSync(path.dirname(outputMd), { recursive: true })
  fs.writeFileSync(outputMd, md)
  console.log(`[aggregate] wrote ${outputMd}`)

  const merged = {
    generatedAt: new Date().toISOString(),
    platformCount: reports.length,
    commitInfo,
    reports: reports.map((r) => ({
      kind: r.kind,
      source: r.source,
      meta: r.data.meta || null,
      summary: r.data.summary || []
    }))
  }
  fs.mkdirSync(path.dirname(outputJson), { recursive: true })
  fs.writeFileSync(outputJson, JSON.stringify(merged, null, 2))
  console.log(`[aggregate] wrote ${outputJson}`)
}

main()
