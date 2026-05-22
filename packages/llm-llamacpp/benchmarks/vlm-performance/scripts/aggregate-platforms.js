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

// Human-friendly description of what one comparison source actually is.
// Used in the top-level "Comparison" block so a reader can read
// "Baseline (model@unsloth-Q4_K_M): unsloth/Qwen3.5-0.8B-GGUF
// @ 6ab46149, Q4_K_M, 507.85 MB" without hunting through the
// provenance table.
function describeSource (s) {
  if (!s) return '-'
  const parts = []
  if (s.hfRepo) {
    const rev = s.hfRevision ? ` @ \`${s.hfRevision.slice(0, 8)}\`` : ''
    parts.push(`\`${s.hfRepo}\`${rev}`)
  }
  if (s.quant) parts.push(s.quant)
  const sizeMb = s.provenance && s.provenance.llm && s.provenance.llm.sizeMb
  if (sizeMb != null) parts.push(`${sizeMb} MB`)
  const sha = s.provenance && s.provenance.llm && s.provenance.llm.sha256
  if (sha) parts.push(`SHA-256 \`${sha.slice(0, 12)}…\``)
  return parts.length ? parts.join(', ') : '-'
}

const COMPARISON_MODE_LABELS = {
  'model-variants': 'two model variants (same addon, different GGUF blobs)',
  'addon-versions': 'two addon versions (same model, different `@qvac/llm-llamacpp` builds)',
  'git-hashes': 'two git commits (full source-level rebuild)',
  none: 'none (candidate-only run)'
}

// Top-level "what is this run comparing" header. Renders the
// comparison mode + which source plays the baseline vs candidate
// role + a one-line description of each source. When no baseline
// was requested, surfaces a single candidate line and a tip on how
// to enable comparison.
function renderComparisonBlock (reports) {
  const firstVlm = reports.find((r) => r.kind === 'vlm-perf')
  if (!firstVlm) return null
  const meta = firstVlm.data && firstVlm.data.meta
  if (!meta) return null
  const sources = meta.modelSources || []
  const mode = meta.comparisonMode || (sources.length > 1 ? 'model-variants' : 'none')
  const candidate = sources.find((s) => s.key === 'candidate')
  const baseline = sources.find((s) => s.key === 'baseline')

  const lines = []
  lines.push('## Comparison')
  lines.push('')
  lines.push(`- **Mode**: ${COMPARISON_MODE_LABELS[mode] || mode}`)
  if (baseline) {
    lines.push(`- **Baseline** (\`${baseline.label}\`): ${describeSource(baseline)}`)
    lines.push(`- **Candidate** (\`${candidate.label}\`): ${describeSource(candidate)}`)
  } else if (candidate) {
    lines.push(`- **Candidate** (\`${candidate.label}\`): ${describeSource(candidate)}`)
    lines.push('- _No baseline - run with `compare_baseline=true` to compare._')
  }
  lines.push('')
  return lines.join('\n')
}

// One sub-table per platform; inside each sub-table, one row per
// backend group containing (candidate row, baseline row, delta row).
// Replaces the previous flat platform table + standalone verdict
// section so the reader sees candidate vs baseline side-by-side per
// platform without cross-referencing two tables.
function renderPerPlatformBlocks (reports) {
  // Group rows by platform AND keep a reference back to the source
  // report so we can fish out per-platform host hardware metadata.
  const byPlatform = new Map()
  const platformMeta = new Map()
  for (const report of reports) {
    for (const row of summaryOf(report)) {
      const k = `${row.platform}-${row.arch}`
      if (!byPlatform.has(k)) byPlatform.set(k, [])
      byPlatform.get(k).push(row)
      if (!platformMeta.has(k) && report.kind === 'vlm-perf' && report.data && report.data.meta) {
        platformMeta.set(k, report.data.meta)
      }
    }
  }
  if (byPlatform.size === 0) return []

  const lines = []
  lines.push('## Per-platform results')
  lines.push('')
  lines.push(`Each table compares **candidate** against **baseline** on one platform. The Δ row uses a ±${NOISE_BAND_PCT}% noise band — anything inside is reported as "same", anything outside is "better" or "worse" depending on the metric direction.`)
  lines.push('')

  for (const [platform, rows] of byPlatform) {
    lines.push(`### ${platform}`)
    lines.push('')

    // Per-platform host hardware line — CPU model + cores + RAM + GPUs.
    // Used to live in a separate "Host hardware" block at the bottom
    // of the report; folded into each platform sub-section so the
    // hardware that produced the numbers sits right next to them.
    const meta = platformMeta.get(platform)
    if (meta && meta.hardware) {
      const h = meta.hardware
      const gpus = (h.gpus || []).map((g) => `${g.vendor ? g.vendor + ' ' : ''}${g.model || '?'}${g.memoryMb ? ` (${g.memoryMb}MB)` : ''}`).join('; ') || 'none detected'
      lines.push(`Host: ${h.cpu && h.cpu.model ? h.cpu.model : 'unknown CPU'} (${h.cpu ? h.cpu.cores : '?'} cores), ${h.ram ? h.ram.totalGb + ' GB' : '?'} RAM; GPUs: ${gpus}`)
      lines.push('')
    }

    const byBackend = new Map()
    for (const row of rows) {
      if (!byBackend.has(row.backend)) byBackend.set(row.backend, [])
      byBackend.get(row.backend).push(row)
    }
    for (const [backend, brows] of byBackend) {
      const cand = brows.find((r) => String(r.sourceKey || '').toLowerCase() === 'candidate')
      const base = brows.find((r) => String(r.sourceKey || '').toLowerCase() === 'baseline')
      const actualBackends = new Set()
      for (const r of brows) {
        for (const ab of ((r.metrics && r.metrics.actualBackends) || [])) actualBackends.add(ab)
      }
      const actual = actualBackends.size ? Array.from(actualBackends).join(',') : '-'
      lines.push(`Backend requested: \`${backend}\` / actual: \`${actual}\``)
      lines.push('')
      lines.push('| Role | Source | runs | vis-enc (ms) | TTFT (ms) | TPS | wall (ms) | recall | status |')
      lines.push('|---|---|---|---|---|---|---|---|---|')
      if (cand) lines.push(perPlatformRow('candidate', cand))
      if (base) lines.push(perPlatformRow('baseline', base))
      if (cand && base) lines.push(perPlatformDeltaRow(cand, base))
      lines.push('')
    }
  }
  return lines
}

function perPlatformRow (role, row) {
  const m = row.metrics || {}
  const hasError = row.errors && row.errors.length > 0
  const status = m.repeats > 0 ? 'OK' : (hasError ? `FAIL: ${row.errors[0].phase}` : 'FAIL')
  const recall = m.recallScore_median != null
    ? `${m.objectsRecalled}/${m.objectsTotal} (${m.recallScore_median.toFixed(2)})`
    : '-'
  const repeats = m.repeatsTotal != null ? `${m.repeats}/${m.repeatsTotal}` : `${m.repeats || 0}`
  return `| **${role}** | \`${row.sourceLabel}\` | ${repeats} | ${fmt(m.visionEncodeMs_median)} | ${fmt(m.ttftMs_median)} | ${fmt(m.decodeTps_median, 2)} | ${fmt(m.wallMs_median)} | ${recall} | ${status} |`
}

function perPlatformDeltaRow (cand, base) {
  const cm = cand.metrics || {}; const bm = base.metrics || {}
  const v_vis = verdictFor(cm.visionEncodeMs_median, bm.visionEncodeMs_median, true)
  const v_ttft = verdictFor(cm.ttftMs_median, bm.ttftMs_median, true)
  const v_tps = verdictFor(cm.decodeTps_median, bm.decodeTps_median, false)
  const v_wall = verdictFor(cm.wallMs_median, bm.wallMs_median, true)
  let recallVerdict = 'same'
  if (cm.recallScore_median != null && bm.recallScore_median != null) {
    if (cm.recallScore_median > bm.recallScore_median) recallVerdict = 'better'
    else if (cm.recallScore_median < bm.recallScore_median) recallVerdict = 'worse'
  }
  const cell = (v) => `${fmtDelta(v.delta)} ${v.label}`
  return `| **Δ candidate vs baseline** | - | - | ${cell(v_vis)} | ${cell(v_ttft)} | ${cell(v_tps)} | ${cell(v_wall)} | ${recallVerdict} | - |`
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

  // ── Run setup ───────────────────────────────────────────────────
  // Static parameters that hold for every row in the report (model
  // family, image, prompt, ground truth, methodology, reasoning mode).
  // Renders before "Commits under test" and "Comparison" so a reader
  // sees the run configuration first, then which two things are
  // being compared.
  lines.push('## Run setup')
  lines.push('')
  lines.push(`- **Model family**: \`${firstMeta.modelId || 'unknown'}\``)
  lines.push(`- **Image**: \`${firstMeta.image || 'unknown'}\``)
  lines.push(`- **Prompt**: \`${firstMeta.prompt || 'unknown'}\``)
  if (firstMeta.groundTruth) {
    lines.push(`- **Ground truth** (${firstMeta.groundTruthCount} objects): ${firstMeta.groundTruth.join(', ')}`)
  }
  lines.push(`- **Iterations**: ${firstMeta.warmupRuns} warmup + ${firstMeta.measuredRuns} measured per cell, **median** reported`)
  if (firstMeta.thinkingEnabled != null) {
    lines.push(`- **Thinking mode**: ${firstMeta.thinkingEnabled ? 'on' : 'off'}`)
  }
  lines.push('')

  // Commit context — only relevant when the comparison axis is
  // commits / code (addon-versions, git-hashes). In model-variants
  // mode the runtime code is identical at both sides so the commit
  // table is just noise.
  const mode = firstMeta.comparisonMode || 'none'
  const showCommits = commitInfo && (mode === 'addon-versions' || mode === 'git-hashes')
  if (showCommits) {
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
    lines.push('')
  }

  // Comparison block (what's being compared, baseline vs candidate
  // identities). Renders before the per-platform tables so the
  // reader knows what "candidate" and "baseline" mean before seeing
  // them in any table.
  const comparisonBlock = renderComparisonBlock(reports)
  if (comparisonBlock) lines.push(comparisonBlock)


  // Per-platform sub-tables with interleaved candidate + baseline +
  // Δ rows. Replaces the previous flat platform table and the
  // standalone verdict block — the comparison happens IN PLACE next
  // to the values it's about, so the reader doesn't have to
  // cross-reference two separate tables.
  const platformBlocks = renderPerPlatformBlocks(reports)
  for (const ln of platformBlocks) lines.push(ln)

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

  // Host hardware previously had its own block at the bottom; that
  // info now sits inside each per-platform sub-section so the
  // hardware lives next to the numbers it produced.

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
