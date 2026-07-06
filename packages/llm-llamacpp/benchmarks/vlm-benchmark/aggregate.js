'use strict'
// Aggregate [VLMROW] markers from one or more run logs into quality +
// speed matrices (markdown). Quality metrics mirror the local lmms-eval harness:
// VQA accuracy, ANLS, ChartQA relaxed accuracy, multiple-choice accuracy.
//
// Usage: node aggregate.js --title "Linux CPU" --out summary.md <log1> [log2 ...]
//   (no deps; reads [VLMROW]{json}[/VLMROW] lines, prints markdown to stdout + --out)

const fs = require('fs')

// Single source of truth for the two-models column labels (base/candidate); CLI flags
// still override. Loaded best-effort so aggregate works even outside the package.
let CONFIG = {}
try { CONFIG = require('./config.cjs') } catch (_) {}

// Gold references live in the fixture, not in the [VLMROW] markers: an OCR page's gold
// is ~700 chars and, inlined, pushed the marker past Android logcat's per-line limit —
// the clean copy got truncated mid-JSON (losing [/VLMROW]) so the row vanished from the
// report. The harness now omits `gold`; we resolve it by item id here. Markers that
// still carry inline gold (older logs, desktop CLI path) win for back-compat.
const GOLD_BY_ID = {}
try {
  const FIXTURE = require('./fixture.data.cjs')
  for (const it of (FIXTURE.items || [])) GOLD_BY_ID[it.id] = it.gold
} catch (_) {}

const ARTICLES = new Set(['a', 'an', 'the'])
const PUNCT = /[;/[\]"{}()=+\\_\-><@`,?!.]/g

function norm (s) {
  s = String(s == null ? '' : s).toLowerCase().trim().replace(/[\t\n]/g, ' ').replace(PUNCT, ' ')
  return s.split(/\s+/).filter(w => w && !ARTICLES.has(w)).join(' ').trim()
}
function lev (a, b) {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)))
    }
    prev = cur
  }
  return prev[b.length]
}
function toF (s) {
  const f = parseFloat(String(s).replace(/,/g, '').replace(/%/g, '').trim())
  return isNaN(f) ? null : f
}
// Strip the boilerplate small models wrap answers in ("the answer is …", "the title
// is …", surrounding quotes) so a correct answer buried in a sentence still matches.
function extractAnswer (s) {
  let p = String(s == null ? '' : s).trim()
  p = p.replace(/^["'`\s]*(?:the\s+)?(?:answer|title|name|result|value)(?:\s+is)?\s*[:=]?\s*/i, '')
  p = p.replace(/^["'([]+/, '').replace(/["')\].\s]+$/, '')
  return p
}
// Word-set F1 — graded partial credit for near-misses / verbose answers that contain
// the gold words (e.g. "the title is Every Now and Then" vs "every now then").
function tokenF1 (a, b) {
  const A = a.split(/\s+/).filter(Boolean); const B = b.split(/\s+/).filter(Boolean)
  if (!A.length || !B.length) return 0
  const setB = new Set(B); let hit = 0
  for (const w of new Set(A)) if (setB.has(w)) hit++
  if (!hit) return 0
  const prec = hit / new Set(A).size; const rec = hit / new Set(B).size
  return (2 * prec * rec) / (prec + rec)
}
// Graded text similarity used by vqa + anls: exact normalized match = 1; otherwise the
// best of word-overlap F1 and (only when genuinely close) char-level similarity. Wholly
// unrelated answers stay ~0 — partial credit is earned, not floored in.
function textSim (pred, gold) {
  const p = norm(extractAnswer(pred)); const g = norm(gold)
  if (!p && !g) return 1
  if (!p || !g) return 0
  if (p === g) return 1
  const f1 = tokenF1(p, g)
  const cs = 1 - lev(p, g) / Math.max(p.length, g.length, 1)
  return Math.max(f1, cs >= 0.5 ? cs : 0)
}
const SCORERS = {
  // Accuracy with graded partial credit. An exact (normalized) match against ANY gold
  // is 1.0 — we use exact-match accuracy rather than the VQAv2 min(1, hits/3) agreement
  // formula, which is calibrated for 10-annotator sets and unfairly caps few-annotator
  // golds (a correct single-annotator GQA answer would otherwise max out at 0.33). A
  // near-miss earns its word-overlap / similarity score; an unrelated answer stays ~0.
  vqa: (pred, golds) => Math.max(0, ...golds.map(g => textSim(pred, g))),
  anls: (pred, golds) => Math.max(0, ...golds.map(g => textSim(pred, g))),
  relaxed: (pred, golds) => {
    let pf = toF(pred)
    if (pf === null) { const m = String(pred).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); if (m) pf = parseFloat(m[0]) }
    for (const g of golds) {
      const gf = toF(g)
      if (pf !== null && gf !== null) {
        if (gf === 0) { if (Math.abs(pf) < 1e-6) return 1 } else if (Math.abs(pf - gf) / Math.abs(gf) <= 0.05) return 1
      }
      if (norm(pred) === norm(g) || norm(pred).includes(norm(g))) return 1
    }
    return 0
  },
  ocr_contains: (pred, golds) => golds.some(g => String(pred).toLowerCase().includes(String(g).toLowerCase().trim())) ? 1 : 0,
  // Multiple-choice: only credit an answer the model actually states as its choice —
  // an explicit "answer/option <L>" phrase, or a short letter-led reply ("C", "C. pupa").
  // A verbose reasoning paragraph with no stated choice scores 0 rather than grabbing a
  // quasi-random interior letter (which made MC scores noise; see investigation).
  mc: (pred, golds) => {
    const gold = String(golds[0]).trim().toUpperCase()
    const p = String(pred).trim()
    const ans = p.match(/(?:final\s+answer|correct\s+answer|answer(?:\s+is)?|option)\b[^A-Za-z0-9]*([A-Ha-h])\b/i)
    if (ans) return ans[1].toUpperCase() === gold ? 1 : 0
    const lead = p.match(/^[^A-Za-z0-9]*([A-Ha-h])\b/)
    if (lead && p.replace(/[^A-Za-z]/g, '').length <= 30) return lead[1].toUpperCase() === gold ? 1 : 0
    return 0
  }
}
function score (metric, pred, golds) { return (SCORERS[metric] || (() => 0))(pred, golds) }

// ── OCR metrics ───────────────────────────────────────────────────────────
// Classical-OCR scoring per VLM_General_Benchmark.md: CER/WER are error rates
// (↓ lower better, 0 = perfect, >1 = worse-than-empty), BLEU is overlap (↑).
// These live on their OWN path and feed a SEPARATE table — they are never mixed
// into the higher-better "Overall %" quality table (mixing ↑ and ↓ is meaningless).
const OCR_METRICS = new Set(['ocr', 'cer'])
const ocrNorm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim()
const cerOne = (p, g) => g.length ? lev(p, g) / g.length : (p.length ? 1 : 0)
// lev() compares by index + !==, so it works on word arrays too (word-level edits).
const werOne = (p, g) => { const pw = p ? p.split(' ') : []; const gw = g ? g.split(' ') : []; return gw.length ? lev(pw, gw) / gw.length : (pw.length ? 1 : 0) }
function ngrams (a, n) { const o = []; for (let i = 0; i + n <= a.length; i++) o.push(a.slice(i, i + n).join('')); return o }
function bleuOne (p, g) {
  const pw = p ? p.split(' ') : []; const gw = g ? g.split(' ') : []
  if (!pw.length || !gw.length) return 0
  let logsum = 0
  for (let n = 1; n <= 4; n++) {
    const pn = ngrams(pw, n); const gc = {}
    for (const x of ngrams(gw, n)) gc[x] = (gc[x] || 0) + 1
    let hit = 0; const used = {}
    for (const x of pn) if ((gc[x] || 0) > (used[x] || 0)) { hit++; used[x] = (used[x] || 0) + 1 }
    logsum += Math.log((hit + 1) / (pn.length + 1)) // add-1 smoothing (short strings)
  }
  const bp = pw.length >= gw.length ? 1 : Math.exp(1 - gw.length / pw.length) // brevity penalty
  return bp * Math.exp(logsum / 4)
}
// Best (most charitable) over the gold alternatives: min error, max overlap.
// CER/WER are edit-distance ratios that exceed 1.0 when the model OVER-generates — a
// repetition loop emits more wrong text than the gold is long (we've seen raw CER 1.29 /
// WER 2.16 from a stuck table loop). Clamp each item at 1.0: you can never do worse than
// emitting nothing (empty pred = exactly 1.0), so a single degenerate doc can't dominate the
// arithmetic mean and swamp the bounded BLEU. The raw overflow is surfaced as a `deg` flag so
// a looping model stays visible rather than silently capped. Together with BLEU (precision +
// brevity), the clamped triple rewards a model that emits MORE correct and LESS wrong text.
function ocrScore (pred, golds) {
  const p = ocrNorm(pred); const gs = (golds || []).map(ocrNorm).filter(Boolean)
  if (!gs.length) return { cer: null, wer: null, bleu: null, deg: false }
  const rawCer = Math.min(...gs.map(g => cerOne(p, g)))
  const rawWer = Math.min(...gs.map(g => werOne(p, g)))
  return {
    cer: Math.min(1, rawCer),
    wer: Math.min(1, rawWer),
    bleu: Math.max(...gs.map(g => bleuOne(p, g))),
    deg: rawCer > 1 || rawWer > 1
  }
}

// Human-readable task names for the report (fallback to the raw id).
const TASK_LABELS = {
  textvqa: 'TextVQA — read text in natural photos',
  vizwiz: 'VizWiz — photo questions',
  gqa: 'GQA — compositional scene reasoning',
  docvqa: 'DocVQA — document understanding (ANLS)',
  ai2d: 'AI2D — science-diagram multiple choice',
  'ocr-small': 'OCR · small — read a short phrase/sentence',
  'ocr-page': 'OCR · page — full-page text recognition'
}
const taskLabel = t => TASK_LABELS[t] || t

function parseArgs (argv) {
  const out = { files: [], inputs: [], title: 'VLM Matrix', outFile: null, prov: [], mode: '', engine: '', preset: process.env.QVAC_VLM_PRESET || '', base: CONFIG.base || 'model_1', candidate: CONFIG.candidate || 'model_2', versionsB64: process.env.QVAC_VLM_VERSIONS_B64 || '' }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--title') out.title = argv[++i]
    else if (argv[i] === '--out') out.outFile = argv[++i]
    else if (argv[i] === '--mode') out.mode = argv[++i]
    else if (argv[i] === '--engine') out.engine = argv[++i]
    else if (argv[i] === '--preset') out.preset = argv[++i]
    else if (argv[i] === '--base') out.base = argv[++i]
    else if (argv[i] === '--candidate') out.candidate = argv[++i]
    else if (argv[i] === '--versions-b64') out.versionsB64 = argv[++i]
    else if (argv[i] === '--provenance') out.prov.push(argv[++i])
    // --in <host-label> <file>: tag every marker in <file> with a platform
    // label (e.g. linux / s25). [VLMROW].device only carries cpu/gpu, so the
    // caller — which knows which artifact is which platform — supplies the
    // host here; otherwise S25 rows would collapse onto the Linux rows.
    else if (argv[i] === '--in') {
      const label = argv[++i]
      const file = argv[++i]
      out.inputs.push({ label, file })
    } else out.files.push(argv[i])
  }
  return out
}
// llama.cpp/mtmd print these on native stderr (captured by `2>&1 | tee`), NOT via the
// JS logger — so we attribute the timing lines that precede each [VLMROW] to that row.
const VISION_RE = /image (?:slice )?encoded in\s+(\d+(?:\.\d+)?)\s*ms/i
const ROW_RE = /\[VLMROW\](.*?)\[\/VLMROW\]/
const SEG_RE = /\[VLMSEG\](.*?)\[\/VLMSEG\]/
const META_RE = /\[VLMMETA\](.*?)\[\/VLMMETA\]/

// Per-cell vision-encode comes from [VLMSEG] segments (stderr, same stream as the
// `image slice encoded` lines) — alignment-proof. Per-row quality/TTFT/TPS come from
// the [VLMROW] markers (stdout). They're joined on the cell|device key, not position.
function parseLog (inputs) {
  const rows = []
  const vision = {} // host|cell|device -> { segMs: [perSegmentSummedMs], segTiles: [perSegmentEncodeCount] }
  const meta = {} // cell -> { main_origin, mmproj_origin, ... }
  // Android logcat captures each printed line twice (live + flushed bare buffer),
  // so the same [VLMROW] appears more than once. Dedup exact rows per host.
  const seenRows = new Set()
  for (const { label, file } of inputs) {
    const host = label || ''
    let txt = ''
    try { txt = fs.readFileSync(file, 'utf-8') } catch (_) { continue }
    let cur = null
    for (const line of txt.split(/\r?\n/)) {
      const mm = line.match(META_RE)
      if (mm) { try { const m = JSON.parse(mm[1]); meta[m.cell] = m } catch (_) {} continue }
      const sm = line.match(SEG_RE)
      if (sm) {
        try {
          const s = JSON.parse(sm[1])
          cur = `${host}|${s.cell}|${s.device}`
          if (!vision[cur]) vision[cur] = { segMs: [], segTiles: [] }
          vision[cur].segMs.push(0); vision[cur].segTiles.push(0)
        } catch (_) {}
        continue
      }
      const vm = line.match(VISION_RE)
      if (vm && cur && vision[cur] && vision[cur].segMs.length) {
        const v = vision[cur]
        v.segMs[v.segMs.length - 1] += Number(vm[1]); v.segTiles[v.segTiles.length - 1]++
        continue
      }
      const rm = line.match(ROW_RE)
      if (rm) {
        const sig = host + ' ' + rm[1]
        if (seenRows.has(sig)) continue
        seenRows.add(sig)
        try { const r = JSON.parse(rm[1]); r.__host = host; if (r.gold == null && GOLD_BY_ID[r.id] != null) r.gold = GOLD_BY_ID[r.id]; rows.push(r) } catch (_) {}
      }
    }
  }
  return { rows, vision, meta }
}
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const fmtPct = x => x == null ? '—' : (100 * x).toFixed(1)
const fmtNum = (x, d = 1) => x == null ? '—' : Number(x).toFixed(d)

function build (rows, vision, meta, provText, title, opts = {}) {
  const base = opts.base || 'model_1'
  const candidate = opts.candidate || 'model_2'
  // Warmup blocks (block 0) are excluded from every stat per CONTRACT.md — the first pass
  // after a model load carries the JIT/shader spike. Legacy v1 rows (no block field) stay.
  rows = rows.filter(r => r.block !== 0)
  // Drop the first segment per cell as warmup (Vulkan shader-compile / JIT spike on the
  // first encode after each model load) so the mean reflects steady-state encode cost.
  function visStats (key) {
    const v = vision[key]
    if (!v || !v.segMs.length) return { mean: null, tiles: null }
    const drop = v.segMs.length > 3 ? 1 : 0
    const ms = v.segMs.slice(drop)
    const tiles = v.segTiles.slice(drop)
    const tilesMean = mean(tiles)
    // No `image ... encoded in N ms` lines were seen for this group (e.g. on
    // Android the addon's native vision-encode log never reaches logcat) — report
    // it as unavailable rather than a misleading 0.
    if (!tilesMean) return { mean: null, tiles: null }
    return { mean: mean(ms), tiles: tilesMean }
  }
  const visMean = key => visStats(key).mean
  const visSlices = key => visStats(key).tiles
  // group key = host|cell|device (host distinguishes linux vs s25, etc.)
  const keys = []
  const byKey = {}
  for (const r of rows) {
    const k = `${r.__host || ''}|${r.cell}|${r.device}`
    if (!byKey[k]) { byKey[k] = []; keys.push(k) }
    byKey[k].push(r)
  }
  keys.sort()
  const hosts = [...new Set(rows.map(r => r.__host || ''))].sort()
  const devs = [...new Set(rows.map(r => r.device).filter(Boolean))].sort()
  const cells = [...new Set(rows.map(r => r.cell).filter(Boolean))] // models (two-models) or sources
  // Split the task universe by metric family: VQA-family tasks feed the
  // higher-better "%" tables; OCR tasks (CER/WER/BLEU) get their own table.
  const allTasks = [...new Set(rows.map(r => r.task).filter(Boolean))]
  const ocrTasks = allTasks.filter(t => rows.some(r => r.task === t && OCR_METRICS.has(r.metric)))
  const vqaTasks = allTasks.filter(t => !ocrTasks.includes(t))

  // One pass of stats per host|cell|device group, reused across all sections.
  function groupStats (key) {
    const rs = byKey[key]
    if (!rs) return null
    const okRows = rs.filter(r => !r.error)
    const perTask = vqaTasks.map(t => {
      const sc = rs.filter(r => r.task === t && !r.error).map(r => score(r.metric, r.pred, r.gold))
      return mean(sc)
    })
    return {
      total: rs.length,
      n: okRows.length,
      errs: rs.length - okRows.length,
      perTask,
      overall: mean(perTask.filter(v => v != null)),
      // Vision-encode ms + slice count. Native "slice encoded in N ms" stderr
      // segments win where present (CLI legs, where the mtmd helper logs them);
      // addon legs bypass that helper to time the encode, so they fall back to
      // the per-completion `visionEncodeMs` / `visionEncodeTiles` runtime stats
      // — captured on EVERY platform incl. mobile (where the stderr line is not
      // captured at all). This keeps BOTH `mmproj enc` and `tiles` populated for
      // addon legs, which the stderr-only path silently dropped.
      ve: (() => {
        const fromStderr = visMean(key)
        if (fromStderr != null) return fromStderr
        return mean(okRows.map(r => r.vision_enc_ms).filter(v => v != null))
      })(),
      sl: (() => {
        const fromStderr = visSlices(key)
        if (fromStderr != null) return fromStderr
        return mean(okRows.map(r => r.vision_enc_tiles).filter(v => v != null))
      })(),
      ttft: mean(okRows.map(r => r.ttft_ms).filter(v => v != null)),
      tps: mean(okRows.map(r => r.decode_tps).filter(v => v != null)),
      wall: mean(okRows.map(r => r.ms).filter(v => v != null)),
      // Prompt-processing (encode) throughput: prompt + image tokens ingested per second
      // during prefill (TTFT spans vision-encode + prompt-eval). Per-row ratio, then mean.
      encTps: mean(okRows.map(r => (r.prompt_tokens != null && r.ttft_ms) ? r.prompt_tokens / (r.ttft_ms / 1000) : null).filter(v => v != null)),
      // Response generation time: wall minus time-to-first-token = the decode phase (ms).
      genMs: mean(okRows.map(r => (r.ms != null && r.ttft_ms != null) ? r.ms - r.ttft_ms : null).filter(v => v != null)),
      // Peak RSS is a per-process high-water mark; each measured block is its own
      // process, so report the MAX across blocks (not the mean). Populated on every
      // platform the runtime exposes getrusage (desktop + Android); null otherwise.
      rss: (() => { const v = okRows.map(r => r.rss_mb).filter(x => x != null); return v.length ? Math.max(...v) : null })()
    }
  }
  // Avg OCR metrics (CER/WER ↓, BLEU ↑) for a host|cell|device group, over its OCR rows.
  function ocrGroup (key) {
    const rs = (byKey[key] || []).filter(r => OCR_METRICS.has(r.metric) && !r.error)
    if (!rs.length) return null
    const cs = []; const ws = []; const bs = []; let deg = 0
    for (const r of rs) { const o = ocrScore(r.pred, r.gold); if (o.cer != null) { cs.push(o.cer); ws.push(o.wer); bs.push(o.bleu); if (o.deg) deg++ } }
    return { cer: mean(cs), wer: mean(ws), bleu: mean(bs), n: rs.length, deg }
  }
  const OCR_ROWS = [{ k: 'cer', label: 'CER ↓' }, { k: 'wer', label: 'WER ↓' }, { k: 'bleu', label: 'BLEU ↑' }]

  const L = []
  L.push(`## ${title}\n`)
  const modeLabel = opts.mode === 'several-sources'
    ? 'several sources (engine varies; model fixed)'
    : `two models (${base} vs ${candidate}; engine fixed)`
  L.push(`**Mode:** ${modeLabel}  ·  **Engine:** ${opts.engine || 'addon'}\n`)
  if (opts.preset) L.push(`**Preset:** \`${opts.preset}\` _(task set + samples per leg)_\n`)
  const severalSources = opts.mode === 'several-sources'
  L.push(severalSources
    ? '_one fixed model across inference engines · quality = lmms-eval ' +
      '(VQA / ANLS / relaxed / MC), equal-weight mean across tasks._\n'
    : `_comparing two models — base = **${base}**, candidate = **${candidate}** · quality = lmms-eval ` +
      '(VQA / ANLS / relaxed / MC), equal-weight mean across tasks._\n')

  if (!keys.length) { L.push('> ⚠️ No [VLMROW] markers found in the provided logs.\n'); return L.join('\n') }

  // ── 1 · Highlights — Quality + Speed tables ───────────────────────────────
  L.push('# 1 · Highlights\n')
  if (severalSources) {
    // Comparison axis is the engine; one column per source.
    const sources = [...new Set(rows.map(r => r.cell))].sort()
    L.push(`Inference engines on the same model: **${sources.join(', ')}**.\n`)
    L.push('### Quality — overall % per source\n')
    L.push('| Platform · device | ' + sources.join(' | ') + ' |')
    L.push('|' + '---|'.repeat(sources.length + 1))
    for (const host of hosts) {
      for (const dv of devs) {
        const vals = sources.map(s => { const g = groupStats(`${host}|${s}|${dv}`); return g ? fmtPct(g.overall) : '—' })
        if (vals.every(v => v === '—')) continue
        L.push(`| ${host || '—'} · ${dv.toUpperCase()} | ` + vals.join(' | ') + ' |')
      }
    }
    L.push('')
    L.push('### Speed — mmproj-encode ms per source (lower = faster)\n')
    L.push('| Platform · device | ' + sources.join(' | ') + ' |')
    L.push('|' + '---|'.repeat(sources.length + 1))
    for (const host of hosts) {
      for (const dv of devs) {
        const vals = sources.map(s => { const g = groupStats(`${host}|${s}|${dv}`); return g ? fmtNum(g.ve != null ? g.ve : g.ttft, g.ve != null ? 1 : 0) : '—' })
        if (vals.every(v => v === '—')) continue
        L.push(`| ${host || '—'} · ${dv.toUpperCase()} | ` + vals.join(' | ') + ' |')
      }
    }
    L.push('')
    if (ocrTasks.length) {
      L.push('### OCR — avg CER/WER/BLEU per source (CER/WER lower better · BLEU higher better)\n')
      L.push('| Platform · device | metric | ' + sources.join(' | ') + ' |')
      L.push('|' + '---|'.repeat(sources.length + 2))
      for (const host of hosts) {
        for (const dv of devs) {
          const gs = sources.map(s => ocrGroup(`${host}|${s}|${dv}`))
          if (gs.every(g => !g)) continue
          for (const { k, label } of OCR_ROWS) {
            L.push(`| ${host || '—'} · ${dv.toUpperCase()} | ${label} | ` + gs.map(g => fmtNum(g && g[k], 3)).join(' | ') + ' |')
          }
        }
      }
      L.push('')
    }
  } else {
    // Comparison axis is the model: base cell vs candidate cell, per platform · device.
    // One-liner verdict: candidate vs baseline averaged across every platform·device leg
    // in this run. Speed = per-leg mean of the two latency metrics that exist on BOTH
    // cells — vis-encode (mmproj) + TTFT — falling back to whichever one is present (mobile
    // legs usually have TTFT only). Quality = the mean of every quality DIMENSION present on
    // the leg — VQA overall % (higher = better) and an OCR score that blends CER + WER
    // (lower = better) with BLEU (higher = better), each as ONE equal-weighted dimension — so
    // a run with cognitive AND OCR tasks reflects both, not just VQA, and OCR's mixed-direction
    // metrics aren't misread. Each leg gets equal weight (mean of per-leg relative %).
    // Two-models mode only.
    const speedPcts = []
    const qualPcts = []
    for (const host of hosts) {
      for (const dv of devs) {
        const b = groupStats(`${host}|${base}|${dv}`)
        const c = groupStats(`${host}|${candidate}|${dv}`)
        if (!b || !c) continue
        const bParts = []; const cParts = []
        if (b.ve != null && c.ve != null) { bParts.push(b.ve); cParts.push(c.ve) }
        if (b.ttft != null && c.ttft != null) { bParts.push(b.ttft); cParts.push(c.ttft) }
        if (bParts.length) {
          const bs = mean(bParts); const cs = mean(cParts)
          if (bs > 0) speedPcts.push((bs - cs) / bs * 100)
        }
        // VQA overall % is higher = better.
        const qParts = []
        if (b.overall != null && c.overall != null && b.overall > 0) {
          qParts.push((c.overall - b.overall) / b.overall * 100)
        }
        // OCR mixes directions: CER + WER are lower = better (improvement = base − cand),
        // BLEU is higher = better (improvement = cand − base). Blend whichever sub-metrics
        // are present into ONE equal-weighted OCR dimension so OCR doesn't outweigh VQA 3:1
        // and a lower error rate counts as better, not worse.
        const bo = ocrGroup(`${host}|${base}|${dv}`)
        const co = ocrGroup(`${host}|${candidate}|${dv}`)
        if (bo && co) {
          const ocrParts = []
          if (bo.cer != null && co.cer != null && bo.cer > 0) ocrParts.push((bo.cer - co.cer) / bo.cer * 100)
          if (bo.wer != null && co.wer != null && bo.wer > 0) ocrParts.push((bo.wer - co.wer) / bo.wer * 100)
          if (bo.bleu != null && co.bleu != null && bo.bleu > 0) ocrParts.push((co.bleu - bo.bleu) / bo.bleu * 100)
          if (ocrParts.length) qParts.push(mean(ocrParts))
        }
        if (qParts.length) qualPcts.push(mean(qParts))
      }
    }
    const sp = mean(speedPcts)
    const qp = mean(qualPcts)
    const legs = Math.max(speedPcts.length, qualPcts.length)
    const verdict = (v, better, worse) => v == null ? 'n/a' : `**${v >= 0 ? better : worse} ${Math.abs(v).toFixed(1)}%**`
    // Leading emoji summarises the verdict at a glance: 🚀 candidate wins (faster, quality
    // not worse) · ⚖️ trade-off (faster but lower quality, or slower but better) · 🐢 slower
    // · 📊 indeterminate (no comparable metric).
    const fast = sp == null ? null : sp >= 0
    const good = qp == null ? null : qp >= 0
    let icon = '📊'
    if (fast === true && good !== false) icon = '🚀'
    else if (fast === true && good === false) icon = '⚖️'
    else if (fast === false && good === true) icon = '⚖️'
    else if (fast === false) icon = '🐢'
    L.push(`> ${icon} **Summary** — candidate **${candidate}** vs baseline **${base}**: ` +
      `${verdict(sp, 'faster', 'slower')} _(visual-encode + prefill only)_, ` +
      `${verdict(qp, 'better', 'worse')} quality _(full response · VQA + OCR)_ — ` +
      `avg over ${legs} platform·device leg${legs === 1 ? '' : 's'}.\n`)
    L.push(`Two models — **${base}** (base) vs **${candidate}** (candidate), per platform · device.\n`)
    // Relative % difference (cand vs base), shown alongside the absolute Δ in every Highlights
    // comparison table for easier magnitude reading. Relative to the baseline value.
    const relPct = (bv, cv) => (bv != null && cv != null && bv !== 0) ? (cv - bv) / bv * 100 : null
    const fmtRel = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
    L.push(`### Quality — overall %: ${base} vs ${candidate}\n`)
    L.push(`| Platform · device | ${base} % | ${candidate} % | Δ (pp, cand−base) | Δ % (cand−base) |`)
    L.push('|---|---|---|---|---|')
    for (const host of hosts) {
      for (const dv of devs) {
        const b = groupStats(`${host}|${base}|${dv}`)
        const c = groupStats(`${host}|${candidate}|${dv}`)
        if (!b && !c) continue
        const dpp = (b && b.overall != null && c && c.overall != null) ? (c.overall - b.overall) * 100 : null
        L.push(`| ${host || '—'} · ${dv.toUpperCase()} | ${fmtPct(b && b.overall)} | ${fmtPct(c && c.overall)} | ${dpp == null ? '—' : (dpp >= 0 ? '+' : '') + dpp.toFixed(1)} | ${fmtRel(relPct(b && b.overall, c && c.overall))} |`)
      }
    }
    L.push('')
    L.push(`### Speed: ${base} vs ${candidate} (lower = faster; metric is mmproj-encode on desktop, TTFT on mobile)\n`)
    L.push(`| Platform · device | metric | ${base} | ${candidate} | Δ ms (cand−base, −=faster) | Δ % (−=faster) |`)
    L.push('|---|---|---|---|---|---|')
    for (const host of hosts) {
      for (const dv of devs) {
        const b = groupStats(`${host}|${base}|${dv}`)
        const c = groupStats(`${host}|${candidate}|${dv}`)
        if (!b && !c) continue
        // Use the mmproj-encode metric only when BOTH sides have it, else the
        // comparison (Δ / Δ%) collapses to `—` for the missing side — e.g.
        // repack-candidate (has the stat) vs published-baseline (no stat, no
        // mobile stderr). In that case fall back to TTFT, which both sides
        // always report. (Mirrors the Summary blend's `b.ve != null && c.ve`.)
        const useEnc = (b && b.ve != null) && (c && c.ve != null)
        const metric = useEnc ? 'mmproj-enc ms' : 'TTFT ms (incl. enc)'
        const bv = useEnc ? (b && b.ve) : (b && b.ttft)
        const cv = useEnc ? (c && c.ve) : (c && c.ttft)
        const d = useEnc ? 1 : 0
        // Absolute ms delta — robust near zero, unlike a "% faster" that explodes when
        // the baseline is a few ms (e.g. GPU mmproj-encode).
        const dms = (bv != null && cv != null) ? cv - bv : null
        L.push(`| ${host || '—'} · ${dv.toUpperCase()} | ${metric} | ${fmtNum(bv, d)} | ${fmtNum(cv, d)} | ${dms == null ? '—' : (dms >= 0 ? '+' : '') + dms.toFixed(d)} | ${fmtRel(relPct(bv, cv))} |`)
      }
    }
    L.push('')
    // OCR comparison (only when OCR tasks ran): avg of each metric per model + Δ.
    if (ocrTasks.length) {
      L.push(`### OCR — avg CER/WER/BLEU: ${base} vs ${candidate} (CER/WER lower better · BLEU higher better)\n`)
      L.push(`| Platform · device | metric | ${base} | ${candidate} | Δ (cand−base) | Δ % (cand−base) |`)
      L.push('|---|---|---|---|---|---|')
      for (const host of hosts) {
        for (const dv of devs) {
          const b = ocrGroup(`${host}|${base}|${dv}`)
          const c = ocrGroup(`${host}|${candidate}|${dv}`)
          if (!b && !c) continue
          for (const { k, label } of OCR_ROWS) {
            const bv = b && b[k]; const cv = c && c[k]
            const delta = (bv != null && cv != null) ? (cv - bv) : null
            L.push(`| ${host || '—'} · ${dv.toUpperCase()} | ${label} | ${fmtNum(bv, 3)} | ${fmtNum(cv, 3)} | ${delta == null ? '—' : (delta >= 0 ? '+' : '') + delta.toFixed(3)} | ${fmtRel(relPct(bv, cv))} |`)
          }
        }
      }
      L.push('')
    }
  }

  // ── 2 · Details ───────────────────────────────────────────────────────────
  L.push('# 2 · Details\n')
  // Engine versions — the llama.cpp build each source actually ran, and the most recent
  // build that source has available (same or newer). AUTO mode pins every source to the
  // most recent build they ALL support (apples-to-apples by default); MANUAL mode honors
  // the refs set per source (builds may differ). opts.versions comes from resolve-versions.cjs.
  //
  // This auto/manual resolution only applies to CLI engine comparison (fabric/upstream),
  // where a llama.cpp build ref is actually CHOSEN. An addon-only comparison (e.g.
  // addon@candidate vs addon@baseline) bundles whatever llama.cpp each addon build pinned —
  // nothing is auto-resolved, the two builds differ by construction, and we can't read the
  // baseline's bundled engine anyway — so labelling it "chosen automatically" is wrong. The
  // per-source addon versions are already in "Sources — resolved versions" below; only render
  // this table (and its label) when a CLI source is in the comparison.
  if (opts.versions && Array.isArray(opts.versions.sources) &&
      opts.versions.sources.some(s => s.engine === 'fabric-cli' || s.engine === 'upstream-cli')) {
    const vmode = opts.versions.mode
    L.push('### Engine versions — llama.cpp build per source\n')
    L.push(vmode === 'auto'
      ? '_Versions **chosen automatically** — the most recent llama.cpp build supported by every requested source._\n'
      : vmode === 'auto-nocommon'
        ? '_Versions **auto-selected per source** — no single build is common to all requested sources, so each ran its most recent; **builds differ (cross-version comparison)**._\n'
        : '_Versions **set manually** — refs were pinned per source, so builds may differ._\n')
    L.push('| Source | build used | most recent available |')
    L.push('|---|---|---|')
    for (const s of opts.versions.sources) {
      L.push(`| \`${s.engine}\` | ${s.chosenTag == null ? '—' : s.chosenTag} | ${s.latestTag == null ? '—' : s.latestTag} |`)
    }
    L.push('')
  }
  // Sources legend — what each compared source resolves to (e.g. addon@candidate =
  // git:<sha>, addon@baseline = npm:0.24.0), so a reader knows exactly which builds the
  // columns above represent. Keyed by the report's comparison cell; shown only when the
  // markers carry a resolved version.
  const refByCell = {}
  for (const r of rows) if (r.source_ref && !refByCell[r.cell]) refByCell[r.cell] = r.source_ref
  const refCells = Object.keys(refByCell).sort()
  if (refCells.length) {
    L.push('### Sources — resolved versions\n')
    L.push('| Source | Resolved version |')
    L.push('|---|---|')
    for (const c of refCells) L.push(`| \`${c}\` | \`${refByCell[c]}\` |`)
    L.push('')
  }
  if (Object.keys(meta).length) {
    L.push('### Models & origins (Source = Registry / HF / S3 / URL · pinned commits)\n')
    L.push('| Cell | main model | mmproj |')
    L.push('|---|---|---|')
    for (const cell of Object.keys(meta).sort()) {
      const m = meta[cell]
      const main = `**${m.main_source || '—'}** · ${m.main_origin || '—'}`
      const proj = `**${m.mmproj_source || '—'}** · ${m.mmproj_origin || '—'}`
      L.push(`| \`${cell}\` | ${main} | ${proj} |`)
    }
    L.push('')
  }
  if (provText && provText.trim()) {
    L.push('### Provenance — hardware & software\n')
    L.push(provText.trim() + '\n')
  }
  L.push('### Quality (%)\n')
  L.push('| Config | host | ' + vqaTasks.join(' | ') + ' | **Overall %** |')
  L.push('|' + '---|'.repeat(vqaTasks.length + 3))
  for (const k of keys) {
    const [host, cell, dev] = k.split('|')
    const g = groupStats(k)
    L.push(`| \`${cell}\` · ${dev.toUpperCase()} | ${host || '—'} | ` + g.perTask.map(fmtPct).join(' | ') + ` | **${fmtPct(g.overall)}** |`)
  }
  L.push('')

  // Per-task quality, the way a reader picks a model for a task: human-readable
  // task name × each model (or each source) as columns, % mean across platforms.
  if (vqaTasks.length && cells.length) {
    const pctCellTask = (cell, t) => mean(rows.filter(r => r.cell === cell && r.task === t && !r.error)
      .map(r => score(r.metric, r.pred, r.gold)))
    const axis = severalSources ? 'source' : 'model'
    L.push(`### Quality by task (% — higher better, mean across platforms; one column per ${axis})\n`)
    L.push('| Task | ' + cells.join(' | ') + ' |')
    L.push('|' + '---|'.repeat(cells.length + 1))
    for (const t of vqaTasks) {
      L.push(`| ${taskLabel(t)} | ` + cells.map(c => fmtPct(pctCellTask(c, t))).join(' | ') + ' |')
    }
    L.push('')
  }

  // OCR tasks get their own table — CER/WER are error rates (↓), BLEU overlap (↑);
  // never blended into the % above. One row per task × config that produced OCR rows.
  if (ocrTasks.length) {
    const ocrAgg = (cell, t, host, dev) => {
      const rs = rows.filter(r => r.cell === cell && r.task === t && (r.__host || '') === host && r.device === dev && !r.error)
      const cs = []; const ws = []; const bs = []; let deg = 0
      for (const r of rs) { const o = ocrScore(r.pred, r.gold); if (o.cer != null) { cs.push(o.cer); ws.push(o.wer); bs.push(o.bleu); if (o.deg) deg++ } }
      return { cer: mean(cs), wer: mean(ws), bleu: mean(bs), n: rs.length, deg }
    }
    L.push('### OCR — text recognition (CER ↓ / WER ↓ lower better · BLEU ↑ higher better)\n')
    L.push('| Task | Config | host | CER ↓ | WER ↓ | BLEU ↑ | loops |')
    L.push('|---|---|---|---|---|---|---|')
    let anyDeg = false
    for (const t of ocrTasks) {
      for (const k of keys) {
        const [host, cell, dev] = k.split('|')
        const o = ocrAgg(cell, t, host, dev)
        if (!o.n) continue
        if (o.deg) anyDeg = true
        L.push(`| ${taskLabel(t)} | \`${cell}\` · ${dev.toUpperCase()} | ${host || '—'} | ${fmtNum(o.cer, 3)} | ${fmtNum(o.wer, 3)} | ${fmtNum(o.bleu, 3)} | ${o.deg ? '⚠ ' + o.deg + '/' + o.n : '—'} |`)
      }
    }
    L.push('')
    if (anyDeg) {
      L.push('> **loops** counts items where the model over-generated — raw CER/WER > 1.0 ' +
        '(more wrong text than the gold is long, e.g. a repetition loop). Those items are clamped ' +
        'to 1.0 in CER/WER so one degenerate doc cannot dominate the average; the flag keeps the ' +
        'degeneration visible.\n')
    }
  }
  L.push('### Speed\n')
  L.push('| Config | host | n | err | **mmproj enc (ms)** | tiles | TTFT (ms) | encode TPS | decode TPS | gen (ms) | wall (ms) |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const k of keys) {
    const [host, cell, dev] = k.split('|')
    const g = groupStats(k)
    L.push(`| \`${cell}\` · ${dev.toUpperCase()} | ${host || '—'} | ${g.n} | ${g.errs} | ${fmtNum(g.ve, 1)} | ${fmtNum(g.sl, 1)} | ${fmtNum(g.ttft, 0)} | ${fmtNum(g.encTps, 1)} | ${fmtNum(g.tps, 1)} | ${fmtNum(g.genMs, 0)} | ${fmtNum(g.wall, 0)} |`)
  }
  L.push('')
  L.push('> **mmproj enc** is the pure ViT vision-encode time (and **tiles** its slice count). ' +
    'CLI legs parse llama.cpp\'s native stderr (`slice encoded in N ms`); addon legs read the ' +
    'in-process `visionEncodeMs`/`visionEncodeTiles` runtime stats (same ViT encode) — so both ' +
    'columns are populated on every platform, including mobile (Device Farm), where the native ' +
    'stderr line is not captured. ' +
    '**encode TPS** = prompt + image tokens ÷ TTFT (prefill ingest rate); **decode TPS** is the ' +
    'generation rate; **gen (ms)** = wall − TTFT (the response-generation/decode phase). encode TPS ' +
    'and gen (ms) are reported on every platform that emits token counts, `—` where it does not.\n')
  // Peak RSS — its own table so a memory regression is easy to spot per platform ×
  // device × source. One row per host|cell|device; the value is the max across
  // measured blocks (per-process high-water). Populated where the runtime exposes it.
  L.push('### Peak memory (RSS)\n')
  L.push('| Config | host | device | peak RSS (MB) |')
  L.push('|---|---|---|---|')
  for (const k of keys) {
    const [host, cell, dev] = k.split('|')
    const g = groupStats(k)
    L.push(`| \`${cell}\` | ${host || '—'} | ${dev.toUpperCase()} | ${g.rss == null ? '—' : g.rss} |`)
  }
  L.push('')
  L.push('> Peak RSS is the process high-water mark (max across measured blocks), from the ' +
    'runtime\'s getrusage — populated on desktop (Linux / macOS / Windows) and Android. A row ' +
    'shows `—` only where the platform doesn\'t expose it.\n')
  // ── 3 · Test results (Device-Farm-style Metric | Count, per platform) ──────
  L.push('# 3 · Test Results (per platform)\n')
  L.push('| Platform | Metric | Count |')
  L.push('|---|---|---|')
  for (const host of hosts) {
    const hk = keys.filter(k => k.split('|')[0] === (host || ''))
    let total = 0; let passed = 0; let failed = 0
    for (const k of hk) { const g = groupStats(k); total += g.total; passed += g.n; failed += g.errs }
    L.push(`| ${host || '—'} | samples run | ${total} |`)
    L.push(`| ${host || '—'} | passed (inference ok) | ${passed} |`)
    L.push(`| ${host || '—'} | failed | ${failed} |`)
  }
  L.push('')

  // ── 4 · Image samples (per task, with resolution) ─────────────────────────
  const imgRows = []
  const seenImg = new Set()
  for (const r of rows) {
    if (!r.img) continue
    const k = `${r.task}|${r.img}`
    if (seenImg.has(k)) continue
    seenImg.add(k)
    imgRows.push({ task: r.task || '—', img: r.img, wh: (r.img_w && r.img_h) ? `${r.img_w}×${r.img_h}` : '—' })
  }
  imgRows.sort((a, b) => a.task.localeCompare(b.task) || a.img.localeCompare(b.img))
  if (imgRows.length) {
    L.push('# 4 · Image samples\n')
    L.push('| Task | Image | Resolution (W×H) |')
    L.push('|---|---|---|')
    for (const ir of imgRows) L.push(`| ${ir.task} | \`${ir.img}\` | ${ir.wh} |`)
    L.push('')
  }
  return L.join('\n')
}

// Exported for unit/scoring tests (score-check.cjs). The CLI only runs when invoked
// directly, so `require('./aggregate.js')` is side-effect-free.
module.exports = { SCORERS, score, ocrScore, OCR_METRICS, textSim, tokenF1, norm, extractAnswer, build, parseLog }

if (require.main === module) {
  const args = parseArgs(process.argv)
  // Labelled inputs (--in host file) plus any bare positional files (host '').
  const allInputs = args.inputs.concat(args.files.map(f => ({ label: '', file: f })))
  const { rows, vision, meta } = parseLog(allInputs)
  const provText = args.prov.map(p => { try { return fs.readFileSync(p, 'utf-8') } catch (_) { return '' } }).join('\n')
  let versions = null
  try { if (args.versionsB64) versions = JSON.parse(Buffer.from(args.versionsB64, 'base64').toString('utf8')) } catch (_) {}
  const md = build(rows, vision, meta, provText, args.title, { mode: args.mode, engine: args.engine, preset: args.preset, base: args.base, candidate: args.candidate, versions })
  process.stdout.write(md + '\n')
  if (args.outFile) fs.writeFileSync(args.outFile, md + '\n')
}
