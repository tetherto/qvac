#!/usr/bin/env node
'use strict'
// Text suite report: parses [TEXTROW] / [TEXTBATCH] markers from text-*.log files
// (one or more hosts) into a summary, text-report.md and a self-contained
// text-report.html with charts. run-local.cjs calls it after the text suite; it can
// also re-render or merge results:
//
//   node text-report.cjs --dir <results dir>[,<another host's dir>...]
//     [--out <dir>] [--title "..."]

const fs = require('fs')
const path = require('path')
const { parseArgs } = require('./utils')
const { median } = require('./methodology.cjs')
const { SPEC_TYPES, ADDON_SPEC_TYPES } = require('./text-workload.cjs')

const ROW_RE = /\[(TEXTROW|TEXTBATCH)\](.*?)\[\/\1\]/g
const ENGINES = ['addon', 'llama-server']
// Rows for a configuration that never ran (model load / server start failed).
const FAILED_RE = /^(load|start) failed/

// ── parsing ──────────────────────────────────────────────────────────────────

function parseLogs (files) {
  const rows = []
  const batches = []
  for (const { host, file } of files) {
    const txt = fs.readFileSync(file, 'utf8')
    let m
    ROW_RE.lastIndex = 0
    while ((m = ROW_RE.exec(txt)) !== null) {
      let obj
      try { obj = JSON.parse(m[2]) } catch (_) { continue }
      obj.host = host
      ;(m[1] === 'TEXTROW' ? rows : batches).push(obj)
    }
  }
  return { rows, batches }
}

function textLogs (dir) {
  const meta = readJson(path.join(dir, 'text-meta.json')) || {}
  return fs.readdirSync(dir)
    .filter(f => /^text-.*\.log$/.test(f))
    .map(f => ({ host: meta.host || path.basename(dir), file: path.join(dir, f) }))
}

function readJson (p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return null } }

// ── stats ────────────────────────────────────────────────────────────────────

const nums = (rs, k) => rs.map(r => r[k]).filter(v => typeof v === 'number' && Number.isFinite(v))
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
const maxOf = xs => xs.length ? Math.max(...xs) : null
const uniq = xs => [...new Set(xs)]
const measured = rs => rs.filter(r => !r.warmup && !r.error)

function summarize ({ rows, batches }) {
  const hosts = uniq(rows.concat(batches).map(r => r.host))
  const backends = uniq(rows.concat(batches).map(r => r.backend))
  const out = { hosts, backends, single: [], conc: [], spec: [], errors: rows.filter(r => r.error && !FAILED_RE.test(r.error)).length }

  // single stream: per host/backend/engine/prompt length
  const single = measured(rows.filter(r => r.suite === 'single'))
  for (const host of hosts) {
    for (const backend of backends) {
      for (const target of uniq(single.map(r => r.prompt_target)).sort((a, b) => a - b)) {
        for (const engine of ENGINES) {
          const rs = single.filter(r => r.host === host && r.backend === backend && r.engine === engine && r.prompt_target === target)
          if (!rs.length) continue
          out.single.push({
            host,
            backend,
            engine,
            prompt_target: target,
            n: rs.length,
            prompt_tokens: median(nums(rs, 'prompt_tokens')),
            gen_tokens: median(nums(rs, 'gen_tokens')),
            prefill_tps: median(nums(rs, 'pp_tps')),
            decode_tps: median(nums(rs, 'decode_tps')),
            ttft_ms: median(nums(rs, 'ttft_ms')),
            client_ttft_ms: median(nums(rs, 'client_ttft_ms')),
            peak_rss_mb: maxOf(nums(rs, 'rss_mb'))
          })
        }
      }
    }
  }

  // concurrency: per host/backend/engine/level
  const concRows = measured(rows.filter(r => r.suite === 'conc'))
  const concBatches = batches.filter(b => b.suite === 'conc' && !b.warmup)
  for (const host of hosts) {
    for (const backend of backends) {
      for (const n of uniq(concBatches.map(b => b.conc)).sort((a, b) => a - b)) {
        for (const engine of ENGINES) {
          const bs = concBatches.filter(b => b.host === host && b.backend === backend && b.engine === engine && b.conc === n)
          if (!bs.length) continue
          const rs = concRows.filter(r => r.host === host && r.backend === backend && r.engine === engine && r.conc === n)
          out.conc.push({
            host,
            backend,
            engine,
            conc: n,
            rounds: bs.length,
            errors: bs.reduce((s, b) => s + (b.errors || 0), 0),
            agg_tps: median(nums(bs, 'agg_tps')),
            per_req_decode_tps: median(nums(rs, 'client_decode_tps')),
            ttft_ms_median: median(nums(rs, 'client_ttft_ms')),
            ttft_ms_max: maxOf(nums(rs, 'client_ttft_ms')),
            gen_tokens: median(nums(rs, 'gen_tokens')),
            prompt_tokens: median(nums(rs, 'prompt_tokens')),
            peak_rss_mb: maxOf(nums(bs, 'rss_mb'))
          })
        }
      }
    }
  }

  // speculative: per host/backend/engine/spec/level; decode rate per prompt kind
  const specRows = measured(rows.filter(r => r.suite === 'spec'))
  const specBatches = batches.filter(b => b.suite === 'spec' && !b.warmup)
  const cells = uniq(specRows.map(r => `${r.host}|${r.backend}|${r.engine}|${r.spec}|${r.conc}`))
  for (const cell of cells) {
    const [host, backend, engine, spec, concS] = cell.split('|')
    const conc = Number(concS)
    const rs = specRows.filter(r => r.host === host && r.backend === backend && r.engine === engine && r.spec === spec && r.conc === conc)
    const bs = specBatches.filter(b => b.host === host && b.backend === backend && b.engine === engine && b.spec === spec && b.conc === conc)
    const byKind = {}
    for (const kind of uniq(rs.map(r => r.kind))) {
      const k = rs.filter(r => r.kind === kind)
      byKind[kind] = conc === 1 ? median(nums(k, 'decode_tps')) : median(nums(k, 'client_decode_tps'))
    }
    const dn = nums(rs, 'draft_n').reduce((s, x) => s + x, 0)
    const da = nums(rs, 'draft_accepted').reduce((s, x) => s + x, 0)
    const kinds = Object.values(byKind).filter(v => v != null)
    out.spec.push({
      host,
      backend,
      engine,
      spec,
      conc,
      draft_model: (rs.find(r => r.draft_model) || {}).draft_model || null,
      decode_tps_by_prompt: byKind,
      decode_tps: kinds.length ? mean(kinds) : null,
      agg_tps: conc > 1 ? median(nums(bs, 'agg_tps')) : null,
      acceptance: dn > 0 ? da / dn : null,
      gen_tokens: median(nums(rs, 'gen_tokens'))
    })
  }
  // speedup: against the same engine without speculation (same host/backend/level);
  // addon rows also compare against llama-server on the same mode.
  const find = (s, engine, spec) => out.spec.find(x => x.host === s.host && x.backend === s.backend && x.conc === s.conc && x.engine === engine && x.spec === spec)
  for (const s of out.spec) {
    const key = s.conc > 1 ? 'agg_tps' : 'decode_tps'
    const base = find(s, s.engine, 'none')
    s.speedup = base && base[key] && s[key] ? s[key] / base[key] : null
    const server = s.engine === 'addon' ? find(s, 'llama-server', s.spec) : null
    s.addon_vs_server = server && server[key] && s[key] ? s[key] / server[key] : null
  }
  const specRank = s => s === 'none' ? '' : s
  out.spec.sort((x, y) => x.host.localeCompare(y.host) || x.conc - y.conc ||
    specRank(x.spec).localeCompare(specRank(y.spec)) ||
    ENGINES.indexOf(x.engine) - ENGINES.indexOf(y.engine))

  // configurations that failed outright (load / server start), one entry per job
  const seen = new Set()
  out.failed = []
  for (const r of rows.filter(r => r.error && FAILED_RE.test(r.error))) {
    const k = `${r.host}|${r.backend}|${r.engine}|${r.job}`
    if (seen.has(k)) continue
    seen.add(k)
    out.failed.push({ host: r.host, backend: r.backend, engine: r.engine, job: r.job, error: r.error })
  }
  return out
}

const SERVER_ONLY_SPEC = uniq(SPEC_TYPES.filter(s => !ADDON_SPEC_TYPES.includes(s)).map(s => s.startsWith('ngram-') ? 'ngram-*' : s))
const SPEC_NOTE = `Modes both engines support (${ADDON_SPEC_TYPES.join(', ')}; the addon's since llm-llamacpp 0.63.0, draft-mtp with an external head with tetherto/qvac#5232) run on both; ${SERVER_ONLY_SPEC.join(', ')} run on llama-server only. A mode that loads a draft model or external MTP head names it in brackets. Speedup is against the same engine without speculation; "addon vs server" compares the two engines on the same mode. Acceptance = accepted ÷ drafted tokens. Generation stops at EOS (max as configured).`
const SPEC_HEAD = kinds => ['N', 'engine · spec', ...kinds.map(k => `${k} t/s`), 'mean t/s', 'aggregate t/s', 'speedup', 'addon vs server', 'acceptance']
function specCells (r, kinds) {
  const x = v => v == null ? '—' : v.toFixed(2) + '×'
  return [r.conc, `${r.engine} · ${r.spec}${r.draft_model ? ` (${r.draft_model})` : ''}`, ...kinds.map(k => fmt(r.decode_tps_by_prompt[k])), fmt(r.decode_tps), fmt(r.agg_tps), x(r.speedup), x(r.addon_vs_server), r.acceptance == null ? '—' : (100 * r.acceptance).toFixed(0) + '%']
}

// ── formatting ───────────────────────────────────────────────────────────────

const fmt = (v, d = 1) => v == null ? '—' : Number(v).toFixed(d)
const fmtInt = v => v == null ? '—' : String(Math.round(v))
function delta (addon, server, lowerBetter) {
  if (addon == null || server == null || server === 0) return '—'
  const pct = (addon / server - 1) * 100
  const better = lowerBetter ? pct < 0 : pct > 0
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%${Math.abs(pct) >= 3 ? (better ? ' ▲' : ' ▼') : ''}`
}
const backendLabel = (b, meta) => b === 'gpu' ? `GPU${meta && meta.gpu_api ? ` (${meta.gpu_api})` : ''}` : 'CPU'
const hostMeta = (meta, host) => (meta.byHost && meta.byHost[host]) || meta
// One line per host: the builds and parameters that host ran.
function provenance (sum, meta) {
  return sum.hosts.map(host => {
    const m = hostMeta(meta, host)
    return { host, model: m.label || null, shape: m.text_preset || null, addon: m.addon || null, server: m.server || null, params: m.params || null }
  })
}
// One value, or one per host when merged runs differ.
function perHost (prov, key, fallback) {
  const vs = uniq(prov.map(p => p[key]))
  if (vs.length <= 1) return vs[0] || fallback || '?'
  return prov.map(p => `${p.host}: ${p[key] || '?'}`).join(', ')
}
const modelLabel = (prov, meta) => perHost(prov, 'model', meta.label)
const shapeLabel = (prov, meta) => perHost(prov, 'shape', meta.text_preset)
const pair = (list, f) => ENGINES.map(e => list.find(x => x.engine === e && f(x)) || null)

function markdown (sum, meta, title) {
  const L = []
  L.push(`## ${title}`, '')
  const prov = provenance(sum, meta)
  L.push(`**Model:** \`${modelLabel(prov, meta)}\` · **Hosts:** ${sum.hosts.join(', ')} · **Backends:** ${sum.backends.map(b => backendLabel(b, meta)).join(', ')} · **Shape:** \`${shapeLabel(prov, meta)}\``, '')
  for (const p of prov) {
    const at = prov.length > 1 ? ` (${p.host})` : ''
    if (p.addon) L.push(`- addon${at}: \`${p.addon}\``)
    if (p.server) L.push(`- llama-server${at}: ${p.server}`)
    if (p.params) L.push(`- shared engine params${at}: \`${JSON.stringify(p.params)}\``)
  }
  L.push('- greedy (temp 0, seed 42), thinking off, prompt cache off, unique prompt per request; each configuration is a fresh model load / server start', '')
  L.push('Δ columns are addon relative to llama-server: ▲ addon better, ▼ addon worse (|Δ| ≥ 3%).', '')

  if (sum.single.length) {
    L.push('### 1 · Single stream', '')
    L.push('One request at a time, fixed generation length (EOS ignored). Prefill and decode rates are the engines\' own timings.', '')
    for (const host of sum.hosts) {
      for (const backend of sum.backends) {
        const rs = sum.single.filter(r => r.host === host && r.backend === backend)
        if (!rs.length) continue
        L.push(`**${host} · ${backendLabel(backend, hostMeta(meta, host))}**`, '')
        L.push('| prompt | prompt tok (addon / server) | prefill t/s addon | prefill t/s server | Δ | decode t/s addon | decode t/s server | Δ | TTFT ms addon | TTFT ms server |')
        L.push('|---|---|---|---|---|---|---|---|---|---|')
        for (const t of uniq(rs.map(r => r.prompt_target))) {
          const [a, s] = pair(rs, r => r.prompt_target === t)
          L.push(`| p${t} · n${fmtInt((a || s).gen_tokens)} | ${fmtInt(a && a.prompt_tokens)} / ${fmtInt(s && s.prompt_tokens)} | ${fmt(a && a.prefill_tps)} | ${fmt(s && s.prefill_tps)} | ${delta(a && a.prefill_tps, s && s.prefill_tps)} | ${fmt(a && a.decode_tps)} | ${fmt(s && s.decode_tps)} | ${delta(a && a.decode_tps, s && s.decode_tps)} | ${fmtInt(a && a.ttft_ms)} | ${fmtInt(s && s.ttft_ms)} |`)
        }
        L.push('')
      }
    }
  }

  if (sum.conc.length) {
    L.push('### 2 · Concurrent requests', '')
    L.push('N requests in flight at once (addon `parallel = N` / llama-server `-np N`, per-slot KV, not unified). Aggregate = all generated tokens ÷ batch wall time; per-request decode and TTFT are measured by the client, so TTFT includes queueing.', '')
    for (const host of sum.hosts) {
      for (const backend of sum.backends) {
        const rs = sum.conc.filter(r => r.host === host && r.backend === backend)
        if (!rs.length) continue
        L.push(`**${host} · ${backendLabel(backend, hostMeta(meta, host))}**`, '')
        L.push('| N | aggregate t/s addon | aggregate t/s server | Δ | per-req decode addon | per-req decode server | TTFT ms addon | TTFT ms server | peak RSS MB addon / server |')
        L.push('|---|---|---|---|---|---|---|---|---|')
        for (const n of uniq(rs.map(r => r.conc))) {
          const [a, s] = pair(rs, r => r.conc === n)
          L.push(`| ${n} | ${fmt(a && a.agg_tps)} | ${fmt(s && s.agg_tps)} | ${delta(a && a.agg_tps, s && s.agg_tps)} | ${fmt(a && a.per_req_decode_tps)} | ${fmt(s && s.per_req_decode_tps)} | ${fmtInt(a && a.ttft_ms_median)} | ${fmtInt(s && s.ttft_ms_median)} | ${fmtInt(a && a.peak_rss_mb)} / ${fmtInt(s && s.peak_rss_mb)} |`)
        }
        L.push('')
      }
    }
  }

  if (sum.spec.length) {
    L.push('### 3 · Speculative decoding', '')
    L.push(SPEC_NOTE, '')
    for (const host of sum.hosts) {
      for (const backend of sum.backends) {
        const rs = sum.spec.filter(r => r.host === host && r.backend === backend)
        if (!rs.length) continue
        const kinds = uniq(rs.flatMap(r => Object.keys(r.decode_tps_by_prompt)))
        const head = SPEC_HEAD(kinds)
        L.push(`**${host} · ${backendLabel(backend, hostMeta(meta, host))}**`, '')
        L.push(`| ${head.join(' | ')} |`)
        L.push(`|${head.map(() => '---').join('|')}|`)
        for (const r of rs) L.push(`| ${specCells(r, kinds).join(' | ')} |`)
        L.push('')
      }
    }
  }

  if (sum.failed.length) {
    L.push('### Failed configurations', '')
    for (const f of sum.failed) L.push(`- ${f.host} · ${backendLabel(f.backend, hostMeta(meta, f.host))} · ${f.engine} · \`${f.job}\`: ${f.error}`)
    L.push('')
  }

  L.push('### Caveats', '')
  L.push('- Prompt lengths are calibrated once against the first engine\'s tokenizer count; the "prompt tok" column shows what each engine actually processed.')
  L.push('- Under concurrency the addon\'s ctx is split evenly across slots, as is llama-server\'s with `--no-kv-unified`; both have the same per-slot context.')
  L.push('- Peak RSS is the whole-process high-water mark: the `bare` process for the addon (includes the runtime), the server process for llama-server (on macOS, its RSS read after each request).')
  L.push('- Greedy outputs can diverge between engines after some tokens, so generated text (and draft acceptance) is not compared on identical continuations.')
  if (sum.errors) L.push(`- **${sum.errors} request(s) failed**; see the text-*.log files.`)
  L.push('')
  return L.join('\n')
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Grouped bar chart: groups × series (one value per engine).
function barChart (groups, series, opts = {}) {
  const W = 640
  const H = 240
  const pad = { l: 48, r: 12, t: 12, b: 40 }
  const vals = groups.flatMap(g => series.map(s => g.values[s.key])).filter(v => v != null)
  if (!vals.length) return ''
  const max = Math.max(...vals) * 1.12
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const gw = iw / groups.length
  const bw = Math.min(36, (gw - 16) / series.length)
  const y = v => pad.t + ih - (v / max) * ih
  const ticks = 4
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || '')}">`
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${v >= 100 ? Math.round(v) : v.toFixed(1)}</text>`
  }
  groups.forEach((g, gi) => {
    const x0 = pad.l + gi * gw + (gw - bw * series.length) / 2
    series.forEach((s, si) => {
      const v = g.values[s.key]
      if (v == null) return
      const x = x0 + si * bw
      svg += `<rect x="${x + 1}" y="${y(v)}" width="${bw - 2}" height="${pad.t + ih - y(v)}" rx="2" class="s${si}"><title>${esc(g.label)} · ${esc(s.label)}: ${v.toFixed(1)}</title></rect>`
      svg += `<text x="${x + bw / 2}" y="${y(v) - 4}" class="val" text-anchor="middle">${v >= 100 ? Math.round(v) : v.toFixed(1)}</text>`
    })
    svg += `<text x="${pad.l + gi * gw + gw / 2}" y="${H - pad.b + 18}" class="tick" text-anchor="middle">${esc(g.label)}</text>`
  })
  return svg + '</svg>'
}

// Line chart: x = concurrency level, one line per series.
function lineChart (xs, series, opts = {}) {
  const W = 640
  const H = 240
  const pad = { l: 48, r: 12, t: 12, b: 40 }
  const vals = series.flatMap(s => s.points.map(p => p.y)).filter(v => v != null)
  if (!vals.length || xs.length < 1) return ''
  const max = Math.max(...vals) * 1.12
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const x = i => pad.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw)
  const y = v => pad.t + ih - (v / max) * ih
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || '')}">`
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${v >= 100 ? Math.round(v) : v.toFixed(1)}</text>`
  }
  xs.forEach((xv, i) => { svg += `<text x="${x(i)}" y="${H - pad.b + 18}" class="tick" text-anchor="middle">${xv}</text>` })
  svg += `<text x="${pad.l + iw / 2}" y="${H - 6}" class="tick" text-anchor="middle">${esc(opts.xLabel || '')}</text>`
  series.forEach((s, si) => {
    const pts = s.points.map(p => ({ i: xs.indexOf(p.x), y: p.y })).filter(p => p.i >= 0 && p.y != null)
    if (!pts.length) return
    svg += `<polyline fill="none" class="l${si}" points="${pts.map(p => `${x(p.i)},${y(p.y)}`).join(' ')}"/>`
    pts.forEach(p => { svg += `<circle cx="${x(p.i)}" cy="${y(p.y)}" r="3.5" class="s${si}"><title>${esc(s.label)} · ${xs[p.i]}: ${p.y.toFixed(1)}</title></circle>` })
  })
  return svg + '</svg>'
}

function legend (labels) {
  return `<div class="legend">${labels.map((l, i) => `<span><i class="s${i}"></i>${esc(l)}</span>`).join('')}</div>`
}

function htmlTable (head, body) {
  return `<div class="tw"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

function html (sum, meta, title) {
  const sec = []
  const cards = []
  for (const host of sum.hosts) {
    for (const backend of sum.backends) {
      const bl = `${host} · ${backendLabel(backend, hostMeta(meta, host))}`
      const single = sum.single.filter(r => r.host === host && r.backend === backend)
      if (single.length) {
        const ts = uniq(single.map(r => r.prompt_target))
        const groupsP = ts.map(t => ({ label: `p${t}`, values: Object.fromEntries(ENGINES.map(e => [e, (single.find(r => r.engine === e && r.prompt_target === t) || {}).prefill_tps])) }))
        const groupsD = ts.map(t => ({ label: `p${t}`, values: Object.fromEntries(ENGINES.map(e => [e, (single.find(r => r.engine === e && r.prompt_target === t) || {}).decode_tps])) }))
        const ser = ENGINES.map(e => ({ key: e, label: e }))
        cards.push({
          sec: 1,
          h: bl,
          body: `<div class="charts"><figure><figcaption>Prefill tokens/s</figcaption>${barChart(groupsP, ser, { label: 'prefill' })}</figure><figure><figcaption>Decode tokens/s</figcaption>${barChart(groupsD, ser, { label: 'decode' })}</figure></div>${legend(ENGINES)}` +
          htmlTable(['prompt', 'prompt tok (addon / server)', 'prefill addon', 'prefill server', 'Δ', 'decode addon', 'decode server', 'Δ', 'TTFT ms addon', 'TTFT ms server'],
            ts.map(t => { const [a, s] = pair(single, r => r.prompt_target === t); return [`p${t}`, `${fmtInt(a && a.prompt_tokens)} / ${fmtInt(s && s.prompt_tokens)}`, fmt(a && a.prefill_tps), fmt(s && s.prefill_tps), delta(a && a.prefill_tps, s && s.prefill_tps), fmt(a && a.decode_tps), fmt(s && s.decode_tps), delta(a && a.decode_tps, s && s.decode_tps), fmtInt(a && a.ttft_ms), fmtInt(s && s.ttft_ms)] }))
        })
      }
      const conc = sum.conc.filter(r => r.host === host && r.backend === backend)
      if (conc.length) {
        const ns = uniq(conc.map(r => r.conc))
        const agg = ENGINES.map(e => ({ label: e, points: conc.filter(r => r.engine === e).map(r => ({ x: r.conc, y: r.agg_tps })) }))
        const ttft = ENGINES.map(e => ({ label: e, points: conc.filter(r => r.engine === e).map(r => ({ x: r.conc, y: r.ttft_ms_median })) }))
        cards.push({
          sec: 2,
          h: bl,
          body: `<div class="charts"><figure><figcaption>Aggregate tokens/s</figcaption>${lineChart(ns, agg, { xLabel: 'concurrent requests' })}</figure><figure><figcaption>Median TTFT (ms, lower is better)</figcaption>${lineChart(ns, ttft, { xLabel: 'concurrent requests' })}</figure></div>${legend(ENGINES)}` +
          htmlTable(['N', 'aggregate addon', 'aggregate server', 'Δ', 'per-req decode addon', 'per-req decode server', 'TTFT ms addon', 'TTFT ms server', 'peak RSS MB addon / server'],
            ns.map(n => { const [a, s] = pair(conc, r => r.conc === n); return [n, fmt(a && a.agg_tps), fmt(s && s.agg_tps), delta(a && a.agg_tps, s && s.agg_tps), fmt(a && a.per_req_decode_tps), fmt(s && s.per_req_decode_tps), fmtInt(a && a.ttft_ms_median), fmtInt(s && s.ttft_ms_median), `${fmtInt(a && a.peak_rss_mb)} / ${fmtInt(s && s.peak_rss_mb)}`] }))
        })
      }
      const spec = sum.spec.filter(r => r.host === host && r.backend === backend)
      if (spec.length) {
        const kinds = uniq(spec.flatMap(r => Object.keys(r.decode_tps_by_prompt)))
        const level1 = spec.filter(r => r.conc === 1)
        const cfgs = level1.map(r => `${r.engine === 'addon' ? 'addon' : 'server'} · ${r.spec}`)
        const groups = kinds.map(k => ({ label: k, values: Object.fromEntries(level1.map((r, i) => [cfgs[i], r.decode_tps_by_prompt[k]])) }))
        const chart = level1.length ? `<div class="charts one"><figure><figcaption>Decode tokens/s per prompt (1 request)</figcaption>${barChart(groups, cfgs.map(c => ({ key: c, label: c })), { label: 'speculative' })}</figure></div>${legend(cfgs)}` : ''
        cards.push({
          sec: 3,
          h: bl,
          body: chart + htmlTable(SPEC_HEAD(kinds), spec.map(r => specCells(r, kinds)))
        })
      }
    }
  }
  const SECS = {
    1: ['Single stream', 'One request at a time, fixed generation length (EOS ignored). Prefill and decode rates are each engine\'s own timings.'],
    2: ['Concurrent requests', 'N requests in flight (addon parallel = N, llama-server -np N, per-slot KV). Aggregate = generated tokens ÷ batch wall time; TTFT is client-measured and includes queueing.'],
    3: ['Speculative decoding', SPEC_NOTE]
  }
  if (sum.failed.length) {
    cards.push({ sec: 4, h: 'Failed configurations', body: `<ul>${sum.failed.map(f => `<li>${esc(`${f.host} · ${backendLabel(f.backend, hostMeta(meta, f.host))} · ${f.engine} · ${f.job}: ${f.error}`)}</li>`).join('')}</ul>` })
    SECS[4] = ['Failed configurations', 'These configurations did not run; the reason is the engine\'s own error.']
  }
  for (const k of [1, 2, 3, 4]) {
    const cs = cards.filter(c => c.sec === k)
    if (!cs.length) continue
    sec.push(`<section><h2>${k} · ${SECS[k][0]}</h2><p class="note">${esc(SECS[k][1])}</p>${cs.map(c => `<div class="card"><h3>${esc(c.h)}</h3>${c.body}</div>`).join('')}</section>`)
  }
  const prov = provenance(sum, meta)
  const facts = [
    ['Model', modelLabel(prov, meta)],
    ['Hosts', sum.hosts.join(', ')],
    ['Backends', sum.backends.map(b => backendLabel(b, meta)).join(', ')],
    ['Shape', shapeLabel(prov, meta)],
    ...prov.flatMap(p => {
      const at = prov.length > 1 ? ` · ${p.host}` : ''
      return [[`Addon${at}`, p.addon || '—'], [`llama-server${at}`, p.server || '—']]
    })
  ]
  const params = prov.filter(p => p.params).map(p => `<p class="note">Shared engine params${prov.length > 1 ? ` (${esc(p.host)})` : ''}: <code>${esc(JSON.stringify(p.params))}</code></p>`).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Text Engine Benchmark</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--s0:#2563eb;--s1:#ea580c;--s2:#16a34a;--s3:#9333ea;--s4:#0891b2;--s5:#ca8a04}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--s0:#60a5fa;--s1:#fb923c;--s2:#4ade80;--s3:#c084fc;--s4:#22d3ee;--s5:#facc15}}
:root[data-theme=dark]{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--s0:#60a5fa;--s1:#fb923c;--s2:#4ade80;--s3:#c084fc;--s4:#22d3ee;--s5:#facc15}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 4px}h3{font-size:14px;margin:0 0 8px}
.note{color:var(--muted);margin:0 0 12px}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:16px 0}
.facts div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}.facts b{display:block;font-size:12px;color:var(--muted);font-weight:500}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.charts.one{grid-template-columns:1fr}figure{margin:0}figcaption{font-size:12px;color:var(--muted);margin-bottom:4px}
svg{width:100%;height:auto}.grid{stroke:var(--line)}.tick{fill:var(--muted);font-size:11px}.val{fill:var(--fg);font-size:10px}
.s0{fill:var(--s0)}.s1{fill:var(--s1)}.s2{fill:var(--s2)}.s3{fill:var(--s3)}.s4{fill:var(--s4)}.s5{fill:var(--s5)}
.l0{stroke:var(--s0);stroke-width:2}.l1{stroke:var(--s1);stroke-width:2}.l2{stroke:var(--s2);stroke-width:2}.l3{stroke:var(--s3);stroke-width:2}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted);margin:6px 0 10px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.legend i.s0{background:var(--s0)}.legend i.s1{background:var(--s1)}.legend i.s2{background:var(--s2)}.legend i.s3{background:var(--s3)}.legend i.s4{background:var(--s4)}.legend i.s5{background:var(--s5)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{color:var(--muted);font-weight:500}
ul{padding-left:20px}code{font-size:12px}
</style></head><body><main>
<h1>${esc(title)}</h1><p class="note">Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC · greedy (temp 0, seed 42), thinking off, prompt cache off, unique prompt per request, fresh load per configuration. Δ = addon relative to llama-server (▲ addon better, ▼ worse).</p>
<div class="facts">${facts.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>
${params}
${sec.join('\n')}
<section><h2>Caveats</h2><ul>
<li>Prompt lengths are calibrated once against the first engine's token count; tables show what each engine actually processed.</li>
<li>Under concurrency both engines split the context evenly across slots (addon default; llama-server --no-kv-unified).</li>
<li>Peak RSS is the whole-process high-water mark: the bare process for the addon, the server process for llama-server (on macOS, its RSS read after each request).</li>
<li>Greedy outputs can diverge between engines, so draft acceptance is not measured on identical text.</li>
${sum.errors ? `<li><b>${sum.errors} request(s) failed</b>; see the text-*.log files.</li>` : ''}
</ul></section>
</main></body></html>
`
}

// Provenance is per host: each results dir has its own text-meta.json. `meta` keeps
// the first dir's fields as fallbacks and adds byHost, from which the header reads
// each host's model and shape; gpu_api is kept only when every host used the same one.
function loadMeta (dirs) {
  const metas = dirs.map(d => ({ dir: d, m: readJson(path.join(d, 'text-meta.json')) || {} }))
  const byHost = {}
  for (const { dir, m } of metas) byHost[m.host || path.basename(dir)] = m
  const apis = uniq(metas.map(({ m }) => m.gpu_api || null))
  return { ...metas[0].m, gpu_api: apis.length === 1 ? apis[0] : null, byHost }
}

function render (dirs, outDir, title) {
  const files = dirs.flatMap(textLogs)
  const parsed = parseLogs(files)
  const sum = summarize(parsed)
  const meta = loadMeta(dirs)
  fs.writeFileSync(path.join(outDir, 'text-report.md'), markdown(sum, meta, title))
  fs.writeFileSync(path.join(outDir, 'text-report.html'), html(sum, meta, title))
  return sum
}

module.exports = { parseLogs, summarize, render }

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2))
  const dirs = typeof a.dir === 'string' ? a.dir.split(',').map(d => path.resolve(d.trim())).filter(Boolean) : []
  if (!dirs.length) { console.error('usage: node text-report.cjs --dir <results dir>[,<dir>...] [--out <dir>] [--title "..."]'); process.exit(2) }
  const outDir = path.resolve(a.out || dirs[0])
  fs.mkdirSync(outDir, { recursive: true })
  render(dirs, outDir, a.title || 'Text benchmark — addon vs llama-server')
  console.log(`[text-report] ${path.join(outDir, 'text-report.md')}`)
  console.log(`[text-report] ${path.join(outDir, 'text-report.html')}`)
}
