'use strict'
// QVAC-19178: aggregate [VLMROW] markers from one or more run logs into quality +
// speed matrices (markdown). Quality metrics mirror the local lmms-eval harness:
// VQA accuracy, ANLS, ChartQA relaxed accuracy, multiple-choice accuracy.
//
// Usage: node aggregate.js --title "Linux CPU" --out summary.md <log1> [log2 ...]
//   (no deps; reads [VLMROW]{json}[/VLMROW] lines, prints markdown to stdout + --out)

const fs = require('fs')

const TASKS = ['vqav2', 'textvqa', 'docvqa', 'chartqa', 'scienceqa']
const ARTICLES = new Set(['a', 'an', 'the'])
const PUNCT = /[;/\[\]"{}()=+\\_\-><@`,?!.]/g

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
const SCORERS = {
  vqa: (pred, golds) => Math.min(1, golds.filter(g => norm(g) === norm(pred)).length / 3),
  anls: (pred, golds) => {
    const p = norm(pred); let best = 0
    for (const g of golds) {
      const gg = norm(g)
      if (!p && !gg) { best = Math.max(best, 1); continue }
      const sim = 1 - lev(p, gg) / Math.max(p.length, gg.length, 1)
      best = Math.max(best, sim >= 0.5 ? sim : 0)
    }
    return best
  },
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
  mc: (pred, golds) => {
    const gold = String(golds[0]).trim().toUpperCase()
    const p = String(pred).trim()
    const pats = [/^\(?([A-Ha-h])\)?(?:[).:,\s]|$)/, /answer\s*(?:is|:)?\s*\(?([A-Ha-h])\)?\b/i, /option\s*\(?([A-Ha-h])\)?\b/i]
    for (const re of pats) { const m = p.match(re); if (m) return m[1].toUpperCase() === gold ? 1 : 0 }
    const m = p.match(/\b([A-Ha-h])\b/)
    return (m && m[1].toUpperCase() === gold) ? 1 : 0
  }
}
function score (metric, pred, golds) { return (SCORERS[metric] || (() => 0))(pred, golds) }

function parseArgs (argv) {
  const out = { files: [], title: 'VLM Matrix', outFile: null, prov: [] }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--title') out.title = argv[++i]
    else if (argv[i] === '--out') out.outFile = argv[++i]
    else if (argv[i] === '--provenance') out.prov.push(argv[++i])
    else out.files.push(argv[i])
  }
  return out
}
// llama.cpp/mtmd print these on native stderr (captured by `2>&1 | tee`), NOT via the
// JS logger — so we attribute the timing lines that precede each [VLMROW] to that row.
const VISION_RE = /image (?:slice )?encoded in\s+(\d+(?:\.\d+)?)\s*ms/i
const PROMPT_RE = /prompt eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+tokens\s*\([^)]*?(\d+(?:\.\d+)?)\s+tokens per second\)/i
const EVAL_RE = /(?<!prompt )eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+(?:tokens|runs)\s*\([^)]*?(\d+(?:\.\d+)?)\s+tokens per second\)/i
const ROW_RE = /\[VLMROW\](.*?)\[\/VLMROW\]/
const SEG_RE = /\[VLMSEG\](.*?)\[\/VLMSEG\]/
const META_RE = /\[VLMMETA\](.*?)\[\/VLMMETA\]/

// Per-cell vision-encode comes from [VLMSEG] segments (stderr, same stream as the
// `image slice encoded` lines) — alignment-proof. Per-row quality/TTFT/TPS come from
// the [VLMROW] markers (stdout). They're joined on the cell|device key, not position.
function parseLog (files) {
  const rows = []
  const vision = {} // cell|device -> { sumMs, segs, enc }
  const meta = {} // cell -> { main_origin, mmproj_origin, ... }
  for (const f of files) {
    let txt = ''
    try { txt = fs.readFileSync(f, 'utf-8') } catch (_) { continue }
    let cur = null
    for (const line of txt.split(/\r?\n/)) {
      const mm = line.match(META_RE)
      if (mm) { try { const m = JSON.parse(mm[1]); meta[m.cell] = m } catch (_) {} continue }
      const sm = line.match(SEG_RE)
      if (sm) {
        try {
          const s = JSON.parse(sm[1])
          cur = `${s.cell}|${s.device}`
          if (!vision[cur]) vision[cur] = { sumMs: 0, segs: 0, enc: 0 }
          vision[cur].segs++
        } catch (_) {}
        continue
      }
      const vm = line.match(VISION_RE)
      if (vm && cur) { vision[cur].sumMs += Number(vm[1]); vision[cur].enc++; continue }
      const rm = line.match(ROW_RE)
      if (rm) { try { rows.push(JSON.parse(rm[1])) } catch (_) {} }
    }
  }
  return { rows, vision, meta }
}
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const fmtPct = x => x == null ? '—' : (100 * x).toFixed(1)
const fmtNum = (x, d = 1) => x == null ? '—' : Number(x).toFixed(d)

function build (rows, vision, meta, provText, title) {
  const visMean = key => (vision[key] && vision[key].segs) ? vision[key].sumMs / vision[key].segs : null
  const visSlices = key => (vision[key] && vision[key].segs) ? vision[key].enc / vision[key].segs : null
  // group key = cell|device
  const keys = []
  const byKey = {}
  for (const r of rows) {
    const k = `${r.cell}|${r.device}`
    if (!byKey[k]) { byKey[k] = []; keys.push(k) }
    byKey[k].push(r)
  }
  keys.sort()
  const L = []
  L.push(`## ${title}\n`)
  L.push(`Engine: **@qvac/llm-llamacpp addon**. Rows = model·mmproj · device. ` +
    `**f16 = mmproj already in the registry; q8 = candidate.** Quality = lmms-eval metrics ` +
    `(VQA-acc / ANLS / relaxed / MC); Overall % = equal-weight mean across tasks.\n`)
  // Provenance (HW/SW from the workflow) + model origins (from [VLMMETA])
  if (provText && provText.trim()) {
    L.push('### Provenance — hardware & software\n')
    L.push(provText.trim() + '\n')
  }
  if (Object.keys(meta).length) {
    L.push('### Models & origins (pinned commits)\n')
    L.push('| Cell | main model | mmproj |')
    L.push('|---|---|---|')
    for (const cell of Object.keys(meta).sort()) {
      const m = meta[cell]
      L.push(`| \`${cell}\` | ${m.main_origin || '—'} | ${m.mmproj_origin || '—'} |`)
    }
    L.push('')
  }
  // Quality
  L.push('### Quality (%)\n')
  L.push('| Config | ' + TASKS.join(' | ') + ' | **Overall %** |')
  L.push('|' + '---|'.repeat(TASKS.length + 2))
  for (const k of keys) {
    const rs = byKey[k]
    const perTask = TASKS.map(t => {
      const sc = rs.filter(r => r.task === t && !r.error).map(r => score(r.metric, r.pred, r.gold))
      return mean(sc)
    })
    const overall = mean(perTask.filter(v => v != null))
    const [cell, dev] = k.split('|')
    L.push(`| \`${cell}\` · ${dev.toUpperCase()} | ` + perTask.map(fmtPct).join(' | ') + ` | **${fmtPct(overall)}** |`)
  }
  L.push('')
  // Speed — mmproj/vision-encode time is the headline metric for Q8 vs f16
  L.push('### Speed (mmproj vision-encode is the headline metric)\n')
  L.push('| Config | n | err | **mmproj enc (ms)** | tiles | TTFT (ms) | decode TPS | wall (ms) |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const k of keys) {
    const rs = byKey[k]
    const okRows = rs.filter(r => !r.error)
    const errs = rs.length - okRows.length
    const ve = visMean(k)
    const sl = visSlices(k)
    const tt = mean(okRows.map(r => r.ttft_ms).filter(v => v != null))
    const dt = mean(okRows.map(r => r.decode_tps).filter(v => v != null))
    const wall = mean(okRows.map(r => r.ms).filter(v => v != null))
    const [cell, dev] = k.split('|')
    L.push(`| \`${cell}\` · ${dev.toUpperCase()} | ${okRows.length} | ${errs} | ${fmtNum(ve, 1)} | ${fmtNum(sl, 1)} | ${fmtNum(tt, 0)} | ${fmtNum(dt, 1)} | ${fmtNum(wall, 0)} |`)
  }
  L.push('')
  // The headline of the whole exercise: mmproj Q8 vs f16 vision-encode delta.
  L.push('### mmproj Q8 vs f16 — vision-encode time (lower = faster; +% = Q8 faster)\n')
  L.push('| Model | Device | Q8 enc (ms) | f16 enc (ms) | tiles | **Q8 faster by** |')
  L.push('|---|---|---|---|---|---|')
  const models = [...new Set(rows.map(r => r.model).filter(Boolean))].sort()
  const devs = [...new Set(rows.map(r => r.device).filter(Boolean))].sort()
  for (const md of models) {
    for (const dv of devs) {
      const q = visMean(`${md}-q8|${dv}`)
      const f = visMean(`${md}-f16|${dv}`)
      if (q == null && f == null) continue
      const tiles = visSlices(`${md}-q8|${dv}`)
      const pct = (q != null && f != null && f !== 0) ? ((f - q) / f * 100) : null
      L.push(`| ${md} | ${dv.toUpperCase()} | ${fmtNum(q, 1)} | ${fmtNum(f, 1)} | ${fmtNum(tiles, 1)} | ${pct == null ? '—' : (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'} |`)
    }
  }
  L.push('')
  if (!keys.length) L.push('> ⚠️ No [VLMROW] markers found in the provided logs.\n')
  return L.join('\n')
}

const args = parseArgs(process.argv)
const { rows, vision, meta } = parseLog(args.files)
const provText = args.prov.map(p => { try { return fs.readFileSync(p, 'utf-8') } catch (_) { return '' } }).join('\n')
const md = build(rows, vision, meta, provText, args.title)
process.stdout.write(md + '\n')
if (args.outFile) fs.writeFileSync(args.outFile, md + '\n')
