#!/usr/bin/env node
'use strict'

// Unified benchmark report renderer for the Qwen3.5 perf benchmark.
//
// Reads perf JSON from --dir (recursively) and renders ONE markdown report:
//   - header with addon version, prompt size, runs-per-config, GPU
//   - one table per device: Config | TTFT (ms) | TPS | ppTPS | Tokens
//   - optional Δ columns when --compare-dir is provided (cross-run regression)
//   - a closing "best config per device" summary
//
// Two input schemas are normalised:
//   desktop sweep:  { models:[{modelId, cases:[{quantization, runtimeConfig,
//                    metrics:{ttftMsMean,tpsMean,ppTpsMean,promptTokens,
//                    generatedTokens}, status, isBaseline}]}], repeats, ... }
//   mobile report:  { addon, device:{name}, results:[{test, metrics:{ttft_ms,
//                    tps, pp_tps, generated_tokens, prompt_tokens}}] }

const fs = require('fs')
const path = require('path')
const { matrix, mobileShardKey, SIZES, QUANTS, CACHE_TYPES } = require('../../test/integration/_benchmark-matrix.js')

function parseArgs (argv) {
  const a = {
    dir: null,
    output: null,
    html: null,
    chartsUrl: null,
    desktopDevice: 'Desktop (linux-x64 GPU)',
    addonVersion: null,
    compareDir: null,
    baselineRunId: null,
    baselineRunNumber: null,
    baselineRunUrl: null
  }
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--dir') a.dir = argv[++i]
    else if (t === '--output') a.output = argv[++i]
    else if (t === '--html') a.html = argv[++i]
    else if (t === '--charts-url') a.chartsUrl = argv[++i]
    else if (t === '--desktop-device') a.desktopDevice = argv[++i]
    else if (t === '--addon-version') a.addonVersion = argv[++i]
    else if (t === '--compare-dir') a.compareDir = argv[++i]
    else if (t === '--baseline-run-id') a.baselineRunId = argv[++i]
    else if (t === '--baseline-run-number') a.baselineRunNumber = argv[++i]
    else if (t === '--baseline-run-url') a.baselineRunUrl = argv[++i]
  }
  if (!a.dir) {
    throw new Error(
      'usage: render-report.js --dir <path> [--output <md>] ' +
      '[--desktop-device <name>] [--addon-version <ver>] [--compare-dir <path>]'
    )
  }
  return a
}

function walkJson (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJson(p))
    else if (entry.name.endsWith('.json')) out.push(p)
  }
  return out
}

function num (v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function int (v) {
  const n = num(v)
  return n !== null ? Math.round(n) : null
}

// Collect metadata and rows from all files in a directory.
// Returns { rows, meta } where meta = { addonVersion, repeats, promptTokens }.
function loadDir (dir, desktopDevice) {
  const files = walkJson(dir)
  // The desktop device name (incl. the detected GPU) is stamped into
  // desktop-meta.json at run time, so re-renders show the real GPU even though
  // the desktop job didn't run. Falls back to the passed/default name.
  //
  // A multi-platform desktop matrix uploads one desktop-meta.json per leg, so
  // a single global name would label Linux, Windows and macOS results all as
  // whichever leg's file happened to be read first — and then aggregate()
  // would merge same-config rows from different platforms under that one
  // device key. Each stamp is therefore scoped to the directory it sits in,
  // and a sweep result takes the name from its nearest stamp.
  const stampByDir = new Map()
  let resolvedDesktop = desktopDevice
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (d && typeof d.desktopDevice === 'string' && d.desktopDevice) {
        stampByDir.set(path.dirname(f), d.desktopDevice)
        if (resolvedDesktop === desktopDevice) resolvedDesktop = d.desktopDevice
      }
    } catch {}
  }
  // Nearest stamp walking upwards, so a per-leg subdirectory wins over a
  // sibling leg's stamp and a single-platform layout behaves exactly as before.
  const deviceFor = (file) => {
    let dir = path.dirname(file)
    for (;;) {
      if (stampByDir.has(dir)) return stampByDir.get(dir)
      const parent = path.dirname(dir)
      if (parent === dir) return resolvedDesktop
      dir = parent
    }
  }
  const meta = { addonVersion: null, repeats: null, promptTokens: null, expectedShards: null }
  let rows = []
  for (const f of files) {
    const r = rowsFromFile(f, deviceFor(f), meta)
    rows.push(...r)
  }
  rows = aggregate(rows)
  return { rows, meta, desktopDevice: resolvedDesktop }
}

// Normalise any report file into rows: { device, config, ttft, tps, ppTps, tokens, crashed }
// Also fills in meta fields when found.
function rowsFromFile (file, desktopDevice, meta) {
  let doc
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  const rows = []

  // run-meta.json — the addon version and the expected mobile shard list,
  // stamped into the run's artifacts at benchmark time. Both come from here so a
  // re-render always reflects what THAT run targeted: the version label stays
  // correct after the code moves on, and coverage compares against the run's own
  // matrix rather than the renderer's current one (which may have since grown).
  if (doc && typeof doc.addonVersion === 'string') {
    if (meta.addonVersion === null) meta.addonVersion = doc.addonVersion
    if (meta.expectedShards === null && Array.isArray(doc.expectedShards)) meta.expectedShards = doc.expectedShards
    return rows
  }

  // desktop-meta.json — the desktop device name (resolved in loadDir's first
  // pass); nothing to render from it here.
  if (doc && typeof doc.desktopDevice === 'string') return rows

  // Desktop sweep schema
  if (Array.isArray(doc.models) && doc.models.length && Array.isArray(doc.models[0].cases)) {
    if (num(doc.repeats) !== null && meta.repeats === null) meta.repeats = doc.repeats
    for (const model of doc.models) {
      for (const c of model.cases) {
        if (c.isBaseline) continue
        const rc = c.runtimeConfig || {}
        const config = configLabel({
          model: `${model.modelId}-${c.quantization}`,
          backend: rc.device,
          rb: rc['reasoning-budget'],
          ck: rc['cache-type-k'],
          cv: rc['cache-type-v'],
          bs: rc['batch-size'],
          ctx: rc['ctx-size']
        })
        const m = c.metrics || {}
        if (int(m.promptTokens) !== null && meta.promptTokens === null) {
          meta.promptTokens = int(m.promptTokens)
        }
        const crashed = c.status && c.status !== 'ok' && c.status !== 'partial-failure'
        rows.push({
          device: desktopDevice,
          // Explicit, not inferred. Desktop-vs-mobile used to be decided by
          // comparing a row's device name against one global desktopDevice.
          // With a desktop matrix there are several desktop names, so every
          // leg but the first classified as mobile — gaining a bogus mobile
          // shard-coverage row and leaking into the mobile charts. A
          // load-mode-only dispatch made it worse: the stamp reads
          // "Desktop linux-x64 (<gpu>)" while the load report says
          // "Desktop linux-x64", so even the first leg failed the comparison.
          isDesktop: true,
          config,
          ttft: num(m.ttftMsMean),
          ttftStd: num(m.ttftMsStd),
          tps: num(m.tpsMean),
          tpsStd: num(m.tpsStd),
          ppTps: num(m.ppTpsMean),
          ppTpsStd: num(m.ppTpsStd),
          tokens: int(m.generatedTokens),
          crashed: !!crashed,
          preAggregated: true,
          sampleCount: int(m.repeats)
        })
      }
    }
    return rows
  }

  // Mobile perf-report schema
  if (doc.device && Array.isArray(doc.results)) {
    // doc.addon is the addon NAME ("llamacpp-llm"), not a version — never use
    // it as the version label. The real version comes from run-meta.json.
    const device = (doc.device.name || 'unknown').trim()
    for (const r of doc.results) {
      const m = r.metrics || {}
      if (int(m.prompt_tokens) !== null && meta.promptTokens === null) {
        meta.promptTokens = int(m.prompt_tokens)
      }
      // "No throughput" meant "crashed" while every row measured generation.
      // A load-mode row measures the load only and carries no TTFT/TPS by
      // design, so that heuristic reports a successful measurement as a
      // failure. A row counts as crashed when it says so, or when it produced
      // neither throughput nor load figures — i.e. nothing at all.
      const noThroughput = num(m.ttft_ms) === null && num(m.tps) === null && num(m.pp_tps) === null
      const noLoad = num(m.load_ms) === null && num(m.rss_bytes) === null
      const crashed = (r.status && String(r.status).toLowerCase() === 'crashed') ||
        (noThroughput && noLoad)
      rows.push({
        device,
        config: r.test || '(unknown)',
        ttft: num(m.ttft_ms),
        tps: num(m.tps),
        ppTps: num(m.pp_tps),
        tokens: int(m.generated_tokens),
        crashed: !!crashed,
        // The desktop load-mode runner writes this schema too (it is the one
        // the renderer already parsed), and flags itself so its rows are not
        // taken for a phone's.
        isDesktop: doc.desktop === true,
        // Per-load figures, present from the run that introduced them. Null on
        // older artifacts and on platforms without /proc (iOS), which the
        // load-mode table renders as '—' rather than as a zero.
        loadMs: num(m.load_ms),
        rssBytes: num(m.rss_bytes),
        rssAnonBytes: num(m.rss_anon_bytes),
        rssFileBytes: num(m.rss_file_bytes),
        lockedBytes: num(m.locked_bytes)
      })
    }
    return rows
  }

  return rows
}

function configLabel ({ model, backend, rb, ck, cv, bs, lm, ctx }) {
  const parts = [`[${model}]`]
  if (backend) parts.push(`[${backend}]`)
  if (rb !== undefined && rb !== null && rb !== '') parts.push(`[rb=${rb}]`)
  if (ck || cv) parts.push(ck === cv ? `[kv=${ck}]` : `[kv=${ck || '?'}/${cv || '?'}]`)
  if (bs !== undefined && bs !== null && bs !== '') parts.push(`[bs=${bs}]`)
  if (lm !== undefined && lm !== null && lm !== '') parts.push(`[lm=${lm}]`)
  if (ctx !== undefined && ctx !== null && ctx !== '') parts.push(`[ctx=${ctx}]`)
  return parts.join(' ')
}

function fmt (v, decimals = 2) {
  if (v === null) return '-'
  return (Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals)).toFixed(decimals)
}

function fmtDelta (v) {
  if (v === null) return '-'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${fmt(v)}`
}

// "mean ± std" when there is more than one sample; bare mean otherwise.
function fmtMS (meanV, stdV, sampleCount) {
  if (meanV === null || meanV === undefined) return '-'
  if (stdV !== null && stdV !== undefined && sampleCount && sampleCount > 1) {
    return `${fmt(meanV)} ± ${fmt(stdV)}`
  }
  return fmt(meanV)
}

function mean (values) {
  if (!values.length) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

// Population standard deviation — matches the desktop sweep's math.js stddev.
function stddev (values) {
  if (!values.length) return null
  if (values.length === 1) return 0
  const avg = mean(values)
  let s = 0
  for (const v of values) s += (v - avg) * (v - avg)
  return Math.sqrt(s / values.length)
}

// Group raw rows by (device, config) and reduce each group to a single row
// carrying mean + stddev per metric. Desktop rows arrive pre-aggregated (they
// already hold *Std fields from the 5-repeat sweep); mobile rows arrive as one
// row per repetition and are aggregated here across the non-crashed samples.
function aggregate (rows) {
  const byKey = new Map()
  for (const r of rows) {
    const k = `${r.device}@@${r.config}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(r)
  }
  const out = []
  for (const group of byKey.values()) {
    const { device, config } = group[0]
    const pre = group.find(r => r.preAggregated && !r.crashed)
    if (pre) { out.push(pre); continue }
    if (group.some(r => r.preAggregated)) {
      out.push({ device, config, isDesktop: group.some(r => r.isDesktop), crashed: true, tokens: null }); continue
    }
    const real = group.filter(r => !r.crashed)
    if (!real.length) {
      out.push({ device, config, isDesktop: group.some(r => r.isDesktop), crashed: true, tokens: null }); continue
    }
    const ttftVals = real.map(r => r.ttft).filter(v => v !== null)
    const tpsVals = real.map(r => r.tps).filter(v => v !== null)
    const ppVals = real.map(r => r.ppTps).filter(v => v !== null)
    // Load and resident-memory figures are per LOAD, not per generation: every
    // repetition of a cell shares one load and reports the same numbers, so
    // they are carried through rather than averaged across repetitions (which
    // would average a value with itself). Taking the first non-null keeps them
    // available to the load-mode section; without this they are silently
    // dropped here and every load-mode column renders empty.
    const firstNonNull = (key) => real.find(r => r[key] !== null && r[key] !== undefined)?.[key] ?? null
    out.push({
      device,
      config,
      isDesktop: group.some(r => r.isDesktop),
      crashed: false,
      ttft: mean(ttftVals),
      ttftStd: stddev(ttftVals),
      tps: mean(tpsVals),
      tpsStd: stddev(tpsVals),
      ppTps: mean(ppVals),
      ppTpsStd: stddev(ppVals),
      tokens: real.find(r => r.tokens !== null)?.tokens ?? null,
      loadMs: firstNonNull('loadMs'),
      rssBytes: firstNonNull('rssBytes'),
      rssAnonBytes: firstNonNull('rssAnonBytes'),
      rssFileBytes: firstNonNull('rssFileBytes'),
      lockedBytes: firstNonNull('lockedBytes'),
      sampleCount: real.length
    })
  }
  return out
}

function buildBaselineMap (baseRows) {
  const m = new Map()
  for (const r of baseRows) m.set(`${r.device}@@${r.config}`, r)
  return m
}

// Largest mobile sample count across a run's aggregated rows (the mobile
// repetition count, read from the data rather than hard-coded).
function mobileRepeats (rows, desktopDevice) {
  const counts = rows
    .filter(r => !r.isDesktop && !r.crashed && r.sampleCount)
    .map(r => r.sampleCount)
  return counts.length ? Math.max(...counts) : null
}

// Build the "Addon: X · Prompt: Y · Repeats: ..." metadata line for a run.
function metaLine (meta, addonVersion, hasDesktopRows, mobileReps) {
  const parts = []
  if (addonVersion) parts.push(`**Addon:** \`${addonVersion}\``)
  if (meta.promptTokens !== null) parts.push(`**Prompt:** ${meta.promptTokens} tokens`)
  if (meta.repeats !== null || mobileReps !== null) {
    const reps = []
    if (hasDesktopRows && meta.repeats !== null) reps.push(`desktop=${meta.repeats}`)
    if (mobileReps !== null) reps.push(`mobile=${mobileReps}`)
    parts.push(`**Repeats:** ${reps.join(', ')}`)
  }
  return parts.join(' · ')
}

// Shard key for a mobile row, parsed from its "[<modelId>] [<dev>] [rb=..]
// [kv=<cache>] [bs=<N>] [lm=<mode>]" label, to match _benchmark-matrix.js
// mobileShardKey. [bs=N] appears only on batch-sweep rows and [lm=mode] only on
// load-mode rows, so cross-product rows keep their two-part "<model>|<kv>" key.
function shardKeyOf (config) {
  const model = /^\[([^\]]+)\]/.exec(config)
  const kv = /\[kv=([^\]]+)\]/.exec(config)
  if (!model || !kv) return null
  const bs = /\[bs=([^\]]+)\]/.exec(config)
  if (bs) return `${model[1]}|${kv[1]}|bs${bs[1]}`
  const lm = /\[lm=([^\]]+)\]/.exec(config)
  if (lm) {
    // Load-mode shards are one per (mode, backend) — each backend needs its own
    // process, so each is its own shard — and mobileShardKey encodes the
    // backend as a fourth segment. It has to be reproduced here or every
    // load-mode shard reconciles as missing and the coverage summary reports
    // twelve phantom gaps on a run where all twelve succeeded.
    const backend = /\[(gpu|cpu)\]/.exec(config)
    return `${model[1]}|${kv[1]}|lm${lm[1]}|${backend ? backend[1] : 'unknown'}`
  }
  return `${model[1]}|${kv[1]}`
}

function shardLabel (key) {
  const [model, kv, extra, backend] = key.split('|')
  if (!extra) return `${model} [kv=${kv}]`
  if (extra.startsWith('bs')) return `${model} [kv=${kv}] [bs=${extra.slice(2)}]`
  return `${model} [kv=${kv}] [lm=${extra.slice(2)}]${backend ? ` [${backend}]` : ''}`
}

// Per-device coverage of the mobile shard matrix. Every shard that runs emits
// at least a Crashed placeholder row, so a shard with no row at all never ran
// or its data was lost (e.g. a dropped KV-cache batch artifact). Surfacing this
// keeps a partial run from rendering as a complete-looking report.
function coverageLines (rows, desktopDevice, devices, expectedShards) {
  // Prefer the shard list THIS run stamped into its run-meta; fall back to the
  // renderer's current matrix only for runs predating the stamp. This keeps a
  // re-render of an older run from being scored against a matrix that has since
  // grown (e.g. an old 30-shard run reading 30/70 against today's 70).
  const expected = expectedShards || matrix().map(mobileShardKey)
  const expectedSet = new Set(expected)
  // Every device name that carried a desktop row. A desktop matrix produces
  // several, so excluding only the one global desktopDevice would hand the
  // other legs a mobile shard-coverage row and a missing-shard count for a
  // matrix they never ran.
  const desktopNames = new Set(rows.filter(r => r.isDesktop).map(r => r.device))
  const mobileDevices = devices.filter(d => !desktopNames.has(d))
  if (!mobileDevices.length) {
    return [
      '## Coverage',
      '',
      `**Warning: 0 mobile devices reported.** ${expected.length} shards expected per device. ` +
      'If mobile was enabled for this run, its data was lost (failed job or dropped artifacts).',
      ''
    ]
  }

  const seenByDevice = new Map(mobileDevices.map(d => [d, new Set()]))
  const seenAll = new Set()
  for (const r of rows) {
    if (r.isDesktop) continue
    const k = shardKeyOf(r.config)
    if (!k || !expectedSet.has(k) || !seenByDevice.has(r.device)) continue
    seenByDevice.get(r.device).add(k)
    seenAll.add(k)
  }

  // Only show the dimension breakdown when the expected set came from the live
  // matrix; a stamped older run may have different dimensions than today's code.
  const dims = expectedShards ? '' : ` (${SIZES.length} sizes x ${QUANTS.length} quants x ${CACHE_TYPES.length} KV-cache types, plus the batch sweep)`
  const lines = ['## Coverage', '']
  lines.push(
    `Mobile matrix: ${expected.length} shards expected per device${dims}. ` +
    `${mobileDevices.length} device(s) reported.`
  )
  lines.push('')
  lines.push('| Device | Shards reported |')
  lines.push('| --- | ---: |')
  for (const d of mobileDevices) lines.push(`| ${d} | ${seenByDevice.get(d).size} / ${expected.length} |`)
  lines.push('')

  const missingEverywhere = expected.filter(k => !seenAll.has(k))
  if (missingEverywhere.length) {
    lines.push(`**${missingEverywhere.length} shard(s) produced no data on any device** (likely a dropped batch):`)
    for (const k of missingEverywhere) lines.push(`- ${shardLabel(k)}`)
    lines.push('')
  }
  for (const d of mobileDevices) {
    const miss = expected.filter(k => seenAll.has(k) && !seenByDevice.get(d).has(k))
    if (miss.length) {
      lines.push(`**${d}** is missing ${miss.length} shard(s) other devices reported:`)
      for (const k of miss) lines.push(`- ${shardLabel(k)}`)
      lines.push('')
    }
  }
  return lines
}

function shortDevice (name) {
  return name.replace(/^Apple /, '').replace(/^Samsung Galaxy /, '').replace(/^Google /, '')
}

function mermaidBar (title, ylabel, labels, values) {
  const max = Math.ceil(Math.max(...values, 1) * 1.15)
  return [
    '```mermaid',
    'xychart-beta',
    `    title "${title}"`,
    `    x-axis [${labels.map(l => `"${l}"`).join(', ')}]`,
    `    y-axis "${ylabel}" 0 --> ${max}`,
    `    bar [${values.map(v => Math.round(v * 10) / 10).join(', ')}]`,
    '```'
  ]
}

// One inline at-a-glance bar chart: decode TPS per device at a SINGLE fixed
// configuration — no averaging across backends, sizes or budgets, so every bar
// is one real measured number. xychart-beta is single-series and cannot draw
// error bars, so the per-backend breakdowns by KV-cache type / quantization,
// with 3-rep stddev whiskers, live in the HTML chart artifact.
// The charts hold every axis but one at a single value; an additive sweep
// varies a dimension the charts do not hold, so its rows would land in a
// held-config bucket they were not measured for and silently win the "first
// row" pick. Batch rows are tagged [bs=…] and load-mode rows [lm=…], and no
// cross-product row carries either, so excluding both keeps every chart bucket
// to one cross-product measurement.
function isAdditiveSweepRow (config) {
  return /\[bs=/.test(config) || /\[lm=/.test(config)
}

function mib (bytes) {
  return bytes === null || bytes === undefined ? null : Math.round((bytes / (1024 * 1024)) * 10) / 10
}

// Load-mode section: what each `load_mode` costs to load and to keep resident,
// per device. Separate from the throughput tables because it answers a
// different question with different metrics — load time and resident memory,
// not TTFT/TPS — and because `load_mode` never touches the compute graph, so a
// throughput column would only restate the cross-product's answer.
//
// Reads the [lm=…] rows the additive load-mode sweep produces. Each cell is
// reported once per device; the reasoning-budget and run repeats a cell carries
// all share one load, so the first non-crashed row per (device, mode) stands.
//
// `auto` is the addon's default, so margins are quoted against it. `dio` is
// accepted by the addon but currently discarded by qvac-fabric before the file
// is opened, so it behaves as `none`; it is labelled rather than ranked.
function loadModeSection (rows, desktopDevice, expectedShards) {
  // Which modes this dispatch asked for, read from the shards run-meta
  // stamped. Null (an older artifact with no stamp) means "assume all six",
  // so a re-render of a pre-selector run still reports gaps as before.
  const selectedModes = Array.isArray(expectedShards)
    ? new Set(
        expectedShards
          .map((k) => /\|lm([^|]+)/.exec(k))
          .filter(Boolean)
          .map((m) => m[1])
      )
    : null
  const lmRows = rows.filter(r => /\[lm=/.test(r.config))
  if (lmRows.length === 0) return []

  const out = ['## Load modes', '']
  out.push(
    'What each `load_mode` costs to bring the weights into memory. `auto` is the ' +
    'addon default: it maps the weights unless a selected device reports no mmap ' +
    'support (integrated GPUs, Adreno/OpenCL, Hexagon), in which case it loads ' +
    'them anonymously. Margins are against `auto`.'
  )
  out.push('')
  out.push(
    'Memory is the resident delta across the load. `anon` and `file` come from ' +
    '`/proc` and are blank on platforms without it (iOS); they matter because ' +
    'total `rss` can rank the modes backwards — a mapped load holds the weights ' +
    'in evictable file-backed pages, so it reads higher while costing less of ' +
    'the anonymous memory the system must actually find.'
  )
  out.push('')

  // Keyed by device AND backend. A phone runs every mode on both gpu and cpu,
  // and mmap support differs between them (Adreno's OpenCL backend reports
  // none, the CPU backend supports it), so collapsing them would hide the very
  // difference this sweep exists to measure — and would silently drop whichever
  // backend sorted second.
  const backendOf = (config) => (/\[cpu\]/.test(config) ? 'cpu' : /\[gpu\]/.test(config) ? 'gpu' : null)
  const groups = new Map()
  for (const r of lmRows) {
    const mode = /\[lm=([^\]]+)\]/.exec(r.config)
    if (!mode) continue
    const backend = backendOf(r.config)
    const key = `${r.device}@@${backend || 'unknown'}`
    if (!groups.has(key)) groups.set(key, { device: r.device, backend, modes: new Map() })
    const modes = groups.get(key).modes
    if (!modes.has(mode[1]) || (modes.get(mode[1]).crashed && !r.crashed)) modes.set(mode[1], r)
  }

  // Desktop legs first, then phones; within each, by name. Ordered on the
  // explicit flag rather than a name match, so every desktop platform sorts
  // ahead of the phones instead of only whichever one the stamp named.
  const desktopKeys = new Set(lmRows.filter(r => r.isDesktop).map(r => r.device))
  const keys = [...groups.keys()].sort((a, b) => {
    const da = groups.get(a).device
    const db = groups.get(b).device
    const dda = desktopKeys.has(da)
    const ddb = desktopKeys.has(db)
    if (dda !== ddb) return dda ? -1 : 1
    if (da !== db) return da.localeCompare(db)
    return a.localeCompare(b)
  })

  for (const key of keys) {
    const { device, backend, modes: seen } = groups.get(key)
    if (seen.size === 0) continue

    const auto = seen.get('auto')
    const mmapRow = seen.get('mmap')
    // Margin against `auto` (the real default) and against `mmap` (named
    // explicitly by the acceptance criteria). Both, because correcting the
    // stale premise about which is the default does not remove the
    // requirement to report the mmap margin.
    const pctVs = (ref, r) => {
      if (!ref || ref.crashed || ref.loadMs === null || r.crashed || r.loadMs === null) return '-'
      if (r === ref) return '—'
      const d = ((r.loadMs / ref.loadMs) - 1) * 100
      return `${d >= 0 ? '+' : ''}${Math.round(d * 10) / 10}%`
    }

    out.push(`### ${device}${backend ? ` — ${backend}` : ''}`, '')
    out.push('| Mode | Load (ms) | Δ vs auto | Δ vs mmap | rss (MiB) | anon (MiB) | file (MiB) | locked (MiB) | Status |')
    out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
    // Fixed order, not measured order: a reader comparing two devices should
    // find the same mode on the same line.
    for (const mode of ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio']) {
      const r = seen.get(mode)
      if (!r) {
        // A mode the dispatch deliberately left out is not a coverage gap —
        // saying so would make every narrowed run look broken. Only a mode
        // that WAS selected and produced nothing is a gap, which is the state
        // the acceptance criteria care about.
        out.push(
          selectedModes && !selectedModes.has(mode)
            ? `| \`${mode}\` | - | - | - | - | - | - | - | Not selected for this run |`
            : `| \`${mode}\` | - | - | - | - | - | - | - | **Not measured (coverage gap)** |`
        )
        continue
      }
      if (r.crashed) {
        out.push(`| \`${mode}\` | - | - | - | - | - | - | - | Failed |`)
        continue
      }
      // A lock that silently did not happen is not a measured mlock. Where the
      // locked counter is unavailable (no /proc), say the lock was unverified
      // rather than implying it took effect.
      let status = 'Measured'
      if (mode === 'dio') status = 'Inert (fabric discards the flag)'
      else if (mode === 'mlock' || mode === 'mmap+mlock') {
        if (r.lockedBytes === null || r.lockedBytes === undefined) status = 'Measured (lock unverified)'
        else if (r.lockedBytes === 0) status = 'Measured (lock had no effect)'
      }
      out.push(
        `| \`${mode}\` | ${r.loadMs ?? '-'} | ${pctVs(auto, r)} | ${pctVs(mmapRow, r)} | ` +
        `${mib(r.rssBytes) ?? '-'} | ${mib(r.rssAnonBytes) ?? '-'} | ${mib(r.rssFileBytes) ?? '-'} | ` +
        `${mib(r.lockedBytes) ?? '-'} | ${status} |`
      )
    }
    out.push('')

    // Two metrics can name two different modes, so both are stated and no
    // single overall winner is manufactured. 'dio' is excluded: crowning an
    // alias of `none` would read as advice to set an inert flag.
    const ranked = [...seen.entries()].filter(([m, r]) => m !== 'dio' && !r.crashed)
    const timed = ranked.filter(([, r]) => r.loadMs !== null)
    // Ranked on anonymous RSS where the platform exposes it, because total rss
    // ranks mapped modes backwards — the mapped weights are file-backed and
    // evictable, so a mapped load reads higher on rss while costing less of the
    // memory the system must actually find. Falling back to total rss without
    // saying so would contradict the note above this table.
    const anonRanked = ranked.filter(([, r]) => r.rssAnonBytes !== null && r.rssAnonBytes !== undefined)
    const rssRanked = ranked.filter(([, r]) => r.rssBytes !== null)
    if (timed.length > 0) {
      const fastest = timed.reduce((a, b) => (b[1].loadMs < a[1].loadMs ? b : a))
      out.push(`- fastest load: \`${fastest[0]}\` (${fastest[1].loadMs} ms)`)
    }
    if (anonRanked.length > 0) {
      const leanest = anonRanked.reduce((a, b) => (b[1].rssAnonBytes < a[1].rssAnonBytes ? b : a))
      out.push(`- lowest anonymous resident: \`${leanest[0]}\` (${mib(leanest[1].rssAnonBytes)} MiB anon)`)
    } else if (rssRanked.length > 0) {
      const leanest = rssRanked.reduce((a, b) => (b[1].rssBytes < a[1].rssBytes ? b : a))
      out.push(
        `- lowest total resident: \`${leanest[0]}\` (${mib(leanest[1].rssBytes)} MiB rss) — ` +
        'anonymous RSS unavailable on this platform, so this ranks total rss and may favour an ' +
        'unmapped mode for memory it does not truly cost'
      )
    }
    const missing = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio']
      .filter(m => !seen.has(m) && (!selectedModes || selectedModes.has(m)))
    if (missing.length > 0) {
      out.push(`- ⚠ coverage gap: ${missing.map(m => '`' + m + '`').join(', ')} produced no row here.`)
    }
    out.push('')
  }

  return out
}

function mermaidSection (rows, desktopDevice, chartsUrl) {
  const held = { backend: 'gpu', rb: CHART_RB, size: CHART_SIZE, quant: CHART_QUANT_HELD, kv: CHART_KV_DEFAULT }
  const pts = atConfig(rows, held).filter(r => !r.isDesktop && !r.crashed && r.tps !== null && !isAdditiveSweepRow(r.config))
  if (pts.length < 2) return []
  const byDevice = new Map()
  for (const r of pts) if (!byDevice.has(r.device)) byDevice.set(r.device, r.tps)
  const devices = [...byDevice.keys()].sort((a, b) => byDevice.get(b) - byDevice.get(a))
  const cfg = `Qwen3.5-${CHART_SIZE.toUpperCase()}, ${CHART_QUANT_HELD}, KV ${CHART_KV_DEFAULT}, reasoning on, GPU`
  // The download URL only exists after the artifact is uploaded, so the workflow
  // passes it in post-upload; a local render leaves the artifact name as plain text.
  const artifact = chartsUrl
    ? `[**qwen35-benchmark-findings** artifact](${chartsUrl})`
    : '**qwen35-benchmark-findings** artifact'
  return [
    '## Charts',
    '',
    `> At-a-glance TPS by device at one fixed config: **${cfg}**. ` +
    'Per-backend charts broken down by KV-cache type and quantization, with ±1 stddev over 3 reps, ' +
    `are in the ${artifact} — download and open \`qwen35-benchmark-charts.html\` inside. ` +
    'The full matrix and all sizes are in the tables below.',
    '',
    ...mermaidBar(`TPS by device (${cfg})`, 'TPS', devices.map(shortDevice), devices.map(d => byDevice.get(d))),
    ''
  ]
}

function render (rows, desktopDevice, meta, addonVersionArg, baselineMap, baseline, chartsUrl) {
  const byDevice = new Map()
  for (const r of rows) {
    // Load-mode rows measure load time and residency, not throughput, and
    // carry no TTFT/TPS at all. Left in the per-device throughput tables they
    // would render as a wall of "Crashed" — the absence of a throughput
    // number read as a failure. They have their own section.
    if (/\[lm=/.test(r.config)) continue
    if (!byDevice.has(r.device)) byDevice.set(r.device, [])
    byDevice.get(r.device).push(r)
  }
  const devices = [...byDevice.keys()].sort((a, b) => {
    if (a === desktopDevice) return -1
    if (b === desktopDevice) return 1
    return a.localeCompare(b)
  })

  // Stamped version (from run-meta) wins over any manually-passed value.
  const addonVersion = meta.addonVersion || addonVersionArg || null
  const comparing = baselineMap !== null

  const lines = []
  lines.push('# Qwen3.5 Benchmark Results')
  lines.push('')

  // Current-run metadata block
  const hasDesktopRows = rows.some(r => r.isDesktop)
  const curLine = metaLine(meta, addonVersion, hasDesktopRows, mobileRepeats(rows, desktopDevice))
  if (curLine) {
    lines.push(curLine)
    lines.push('')
  }

  // Baseline metadata block — same fields as the current run, plus the run
  // link. Classify its rows by the BASELINE's own desktop device name (which
  // may differ from the current run's, e.g. a different GPU).
  if (comparing && baseline) {
    const bDesktop = baseline.desktopDevice || desktopDevice
    const bHasDesktop = baseline.rows.some(r => r.device === bDesktop)
    const bAddon = baseline.meta.addonVersion || null
    const bLine = metaLine(baseline.meta, bAddon, bHasDesktop, mobileRepeats(baseline.rows, bDesktop))
    const idParts = []
    if (baseline.runNumber) idParts.push(`run #${baseline.runNumber}`)
    if (baseline.runId) idParts.push(`run ID ${baseline.runId}`)
    const heading = idParts.length ? idParts.join(', ') : 'previous run'
    lines.push(`> **Comparing against baseline (${heading}):**`)
    if (bLine) lines.push('> ' + bLine)
    if (baseline.runUrl) {
      lines.push(`> [View baseline run](${baseline.runUrl})`)
    }
    lines.push('')
  }

  lines.push(
    'Metrics are addon `runtimeStats`: ' +
    'TTFT = time to first token (ms), TPS = decode tokens/sec, ' +
    'ppTPS = prefill tokens/sec, Tokens = generated tokens.' +
    (comparing ? ' Δ = current minus baseline (positive = improvement for TPS/ppTPS, negative = improvement for TTFT).' : '') +
    ' `Crashed` = configuration crashed or produced no output.'
  )
  lines.push('')
  lines.push(
    'Config labels read `[model] [gpu|cpu] [rb=N] [kv=type] [bs=N] [lm=mode] [ctx=N]`, where ' +
    '`rb` is the reasoning budget (-1 leaves the model\'s reasoning channel on, 0 ' +
    'disables it), `kv` is the KV-cache type, `bs` is the batch/ubatch size, ' +
    '`lm` is the model load mode, and `ctx` is the context size. The batch sweep ' +
    'varies `bs` at a fixed baseline against a long context-filling prompt, so its ' +
    'rows carry `ctx=8192`; the load-mode sweep varies `lm` at a fixed baseline and ' +
    'is reported in its own section, since it measures load rather than throughput.'
  )
  lines.push('')

  for (const l of coverageLines(rows, desktopDevice, devices, meta.expectedShards)) lines.push(l)

  for (const l of mermaidSection(rows, desktopDevice, chartsUrl)) lines.push(l)

  for (const l of loadModeSection(rows, desktopDevice, meta.expectedShards)) lines.push(l)

  const hasTokens = rows.some(r => r.tokens !== null)

  for (const device of devices) {
    const items = byDevice.get(device).slice().sort((a, b) => a.config.localeCompare(b.config))
    lines.push(`## ${device}`)
    lines.push('')

    if (comparing && !items.some(r => baselineMap.has(`${r.device}@@${r.config}`))) {
      lines.push('> No baseline data for this device (baseline ran on different hardware).', '')
    }

    if (comparing) {
      const hdr = hasTokens
        ? '| Config | TTFT (ms) | Δ TTFT | TPS | Δ TPS | ppTPS | Δ ppTPS | Tokens |'
        : '| Config | TTFT (ms) | Δ TTFT | TPS | Δ TPS | ppTPS | Δ ppTPS |'
      const sep = hasTokens
        ? '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
        : '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
      lines.push(hdr)
      lines.push(sep)
      for (const r of items) {
        const b = baselineMap.get(`${r.device}@@${r.config}`)
        if (r.crashed) {
          const crash = hasTokens
            ? `| ${r.config} | Crashed | - | Crashed | - | Crashed | - | - |`
            : `| ${r.config} | Crashed | - | Crashed | - | Crashed | - |`
          lines.push(crash)
        } else {
          const dTtft = (b && !b.crashed && r.ttft !== null && b.ttft !== null) ? r.ttft - b.ttft : null
          const dTps = (b && !b.crashed && r.tps !== null && b.tps !== null) ? r.tps - b.tps : null
          const dPp = (b && !b.crashed && r.ppTps !== null && b.ppTps !== null) ? r.ppTps - b.ppTps : null
          const row = hasTokens
            ? `| ${r.config} | ${fmtMS(r.ttft, r.ttftStd, r.sampleCount)} | ${fmtDelta(dTtft)} | ${fmtMS(r.tps, r.tpsStd, r.sampleCount)} | ${fmtDelta(dTps)} | ${fmtMS(r.ppTps, r.ppTpsStd, r.sampleCount)} | ${fmtDelta(dPp)} | ${r.tokens !== null ? r.tokens : '-'} |`
            : `| ${r.config} | ${fmtMS(r.ttft, r.ttftStd, r.sampleCount)} | ${fmtDelta(dTtft)} | ${fmtMS(r.tps, r.tpsStd, r.sampleCount)} | ${fmtDelta(dTps)} | ${fmtMS(r.ppTps, r.ppTpsStd, r.sampleCount)} | ${fmtDelta(dPp)} |`
          lines.push(row)
        }
      }
    } else {
      const hdr = hasTokens
        ? '| Config | TTFT (ms) | TPS | ppTPS | Tokens |'
        : '| Config | TTFT (ms) | TPS | ppTPS |'
      const sep = hasTokens
        ? '| --- | ---: | ---: | ---: | ---: |'
        : '| --- | ---: | ---: | ---: |'
      lines.push(hdr)
      lines.push(sep)
      for (const r of items) {
        if (r.crashed) {
          lines.push(hasTokens
            ? `| ${r.config} | Crashed | Crashed | Crashed | - |`
            : `| ${r.config} | Crashed | Crashed | Crashed |`)
        } else {
          lines.push(hasTokens
            ? `| ${r.config} | ${fmtMS(r.ttft, r.ttftStd, r.sampleCount)} | ${fmtMS(r.tps, r.tpsStd, r.sampleCount)} | ${fmtMS(r.ppTps, r.ppTpsStd, r.sampleCount)} | ${r.tokens !== null ? r.tokens : '-'} |`
            : `| ${r.config} | ${fmtMS(r.ttft, r.ttftStd, r.sampleCount)} | ${fmtMS(r.tps, r.tpsStd, r.sampleCount)} | ${fmtMS(r.ppTps, r.ppTpsStd, r.sampleCount)} |`)
        }
      }
    }
    lines.push('')
  }

  lines.push('## Best configuration per device')
  lines.push('')
  lines.push('| Device | Highest TPS | Highest ppTPS |')
  lines.push('| --- | --- | --- |')
  for (const device of devices) {
    const ok = byDevice.get(device).filter(r => !r.crashed)
    const bestTps = ok.filter(r => r.tps !== null).sort((a, b) => b.tps - a.tps)[0]
    const bestPp = ok.filter(r => r.ppTps !== null).sort((a, b) => b.ppTps - a.ppTps)[0]
    const tpsCell = bestTps ? `${bestTps.config} — ${fmt(bestTps.tps)}` : '-'
    const ppCell = bestPp ? `${bestPp.config} — ${fmt(bestPp.ppTps)}` : '-'
    lines.push(`| ${device} | ${tpsCell} | ${ppCell} |`)
  }
  lines.push('')
  return lines.join('\n') + '\n'
}

// ── Visual HTML report: self-contained inline SVG bar charts, no deps or CDN ──
const CHART_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777']

function rowQuant (config) {
  const m = /^\[qwen[\d.]+-[^-\]]+-([^\]]+)\]/i.exec(config)
  return m ? m[1] : null
}

function rowKv (config) {
  const m = /\[kv=([^\]]+)\]/.exec(config)
  return m ? m[1] : null
}

function rowBackend (config) {
  const m = /\[(gpu|cpu)\]/.exec(config)
  return m ? m[1] : null
}

function rowRb (config) {
  const m = /\[rb=(-?\d+)\]/.exec(config)
  return m ? m[1] : null
}

function rowSize (config) {
  const m = /^\[qwen[\d.]+-([^-\]]+)-/i.exec(config)
  return m ? m[1] : null
}

// Charts hold every axis but the one on the x-axis at a single value, so each
// bar is one real measured configuration rather than an average across gpu/cpu,
// model sizes or reasoning budgets. reasoning-budget -1 is the model's default
// (reasoning channel on; 0 disables it) and KV f16 is llama.cpp's default; the
// featured size and held quant are stated in every chart. gpu and cpu are
// charted separately and never blended.
const CHART_BACKENDS = ['gpu', 'cpu']
const CHART_RB = '-1'
const CHART_SIZE = '2b'
const CHART_KV_DEFAULT = 'f16'
const CHART_QUANT_HELD = 'Q4_K_M'

// Keep only rows sitting at the given fixed point of the matrix; an axis left
// undefined is the one being varied on the x-axis.
function atConfig (rows, { backend, rb, size, quant, kv }) {
  return rows.filter(r =>
    (backend == null || rowBackend(r.config) === backend) &&
    (rb == null || rowRb(r.config) === rb) &&
    (size == null || rowSize(r.config) === size) &&
    (quant == null || rowQuant(r.config) === quant) &&
    (kv == null || rowKv(r.config) === kv)
  )
}

// One bar per device for each category of the varied axis. The caller passes
// rows already pinned to a single point on every OTHER axis (via atConfig), so
// each (device, category) is exactly one measured config: the bar is that row's
// mean and the whisker its own measured 3-rep stddev (stdKey) — never a spread
// recomputed across blended configs.
function chartSeries (rows, desktopDevice, byKey, order, metric, stdKey) {
  const pts = rows.filter(r => !r.isDesktop && !r.crashed && r[metric] !== null && byKey(r.config) !== null)
  const present = new Set(pts.map(r => byKey(r.config)))
  const cats = order.filter(c => present.has(c))
  const devices = [...new Set(pts.map(r => r.device))].sort()
  const series = devices.map((dev, i) => ({
    name: dev,
    color: CHART_COLORS[i % CHART_COLORS.length],
    cells: cats.map(cat => {
      const row = pts.find(r => r.device === dev && byKey(r.config) === cat)
      return row ? { mean: row[metric], std: row[stdKey] != null ? row[stdKey] : null } : null
    })
  }))
  return { cats, series }
}

function svgBarChart (title, unit, cats, series, maxOverride) {
  const W = 860; const H = 360
  const m = { l: 64, r: 16, t: 16, b: 70 }
  const pw = W - m.l - m.r; const ph = H - m.t - m.b
  let max = maxOverride || 0
  if (!maxOverride) for (const s of series) for (const c of s.cells) if (c) max = Math.max(max, c.mean + (c.std || 0))
  const niceMax = (max > 0 ? max : 1) * 1.1
  const y = v => m.t + ph - (v / niceMax) * ph
  const out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" font-family="system-ui,Arial" font-size="12">']
  for (let g = 0; g <= 4; g++) {
    const v = (niceMax / 4) * g; const yy = y(v)
    out.push(`<line x1="${m.l}" y1="${yy.toFixed(1)}" x2="${W - m.r}" y2="${yy.toFixed(1)}" stroke="#e5e7eb"/>`)
    out.push(`<text x="${m.l - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" fill="#6b7280">${fmt(v, v < 10 ? 1 : 0)}</text>`)
  }
  const groupW = pw / cats.length
  const barW = (groupW * 0.74) / series.length
  cats.forEach((cat, ci) => {
    const gx = m.l + ci * groupW + groupW * 0.13
    series.forEach((s, si) => {
      const cell = s.cells[ci]
      if (!cell) return
      const bx = gx + si * barW
      const by = y(cell.mean)
      out.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(barW * 0.92).toFixed(1)}" height="${Math.max(0, m.t + ph - by).toFixed(1)}" fill="${s.color}"><title>${s.name} | ${cat}: ${fmt(cell.mean)} ${unit}</title></rect>`)
      if (cell.std) {
        const cx = (bx + barW * 0.46).toFixed(1)
        out.push(`<line x1="${cx}" y1="${y(cell.mean + cell.std).toFixed(1)}" x2="${cx}" y2="${y(Math.max(0, cell.mean - cell.std)).toFixed(1)}" stroke="#1f2937"/>`)
      }
    })
    out.push(`<text x="${(gx + groupW * 0.37).toFixed(1)}" y="${m.t + ph + 18}" text-anchor="middle" fill="#111827">${cat}</text>`)
  })
  out.push('</svg>')
  return `<figure style="margin:0 0 26px"><figcaption style="font-weight:600;margin:0 0 4px">${title} <span style="font-weight:400;color:#6b7280">(${unit})</span></figcaption>${out.join('')}</figure>`
}

function renderHtml (rows, desktopDevice, meta, addonVersionArg) {
  const addonVersion = meta.addonVersion || addonVersionArg || ''
  const mobile = rows.filter(r => !r.isDesktop && !isAdditiveSweepRow(r.config))
  const devices = [...new Set(mobile.filter(r => !r.crashed).map(r => r.device))].sort()
  const legend = devices.map((d, i) => `<span style="display:inline-flex;align-items:center;margin:0 14px 6px 0"><span style="width:12px;height:12px;background:${CHART_COLORS[i % CHART_COLORS.length]};display:inline-block;margin-right:5px;border-radius:2px"></span>${d}</span>`).join('')
  const KVO = ['f16', 'q8_0', 'q4_0', 'tbq3_0/pq3_0', 'tbq4_0/pq4_0', 'pq3_0', 'pq4_0']
  const QO = ['Q4_0', 'Q4_1', 'Q4_K_M', 'Q6_K', 'Q8_0']
  // [title, unit, byKey, order, metric, stdKey, held]. Each chart varies one axis
  // and holds the rest at a fixed point (size, reasoning budget, and the other
  // categorical). gpu and cpu are rendered as separate charts sharing one y-scale
  // per metric so the backend gap is read correctly.
  const defs = [
    ['TPS by KV-cache type', 'TPS, tokens/sec', rowKv, KVO, 'tps', 'tpsStd', { quant: CHART_QUANT_HELD }],
    ['TPS by quantization', 'TPS, tokens/sec', rowQuant, QO, 'tps', 'tpsStd', { kv: CHART_KV_DEFAULT }],
    ['ppTPS by KV-cache type', 'ppTPS, tokens/sec', rowKv, KVO, 'ppTps', 'ppTpsStd', { quant: CHART_QUANT_HELD }],
    ['TTFT by KV-cache type', 'TTFT, ms (lower is better)', rowKv, KVO, 'ttft', 'ttftStd', { quant: CHART_QUANT_HELD }]
  ]
  let charts = ''
  for (const [title, unit, byKey, order, metric, stdKey, extra] of defs) {
    const perBackend = CHART_BACKENDS.map(backend => {
      const subset = atConfig(mobile, { backend, rb: CHART_RB, size: CHART_SIZE, ...extra })
      return { backend, ...chartSeries(subset, desktopDevice, byKey, order, metric, stdKey) }
    }).filter(b => b.cats.length)
    if (!perBackend.length) continue
    let smax = 0
    for (const b of perBackend) for (const s of b.series) for (const c of s.cells) if (c) smax = Math.max(smax, c.mean + (c.std || 0))
    for (const b of perBackend) charts += svgBarChart(`${title} — ${b.backend.toUpperCase()}`, unit, b.cats, b.series, smax)
  }
  const metaBits = [addonVersion && `Addon <code>${addonVersion}</code>`, meta.promptTokens && `Prompt ${meta.promptTokens} tok`].filter(Boolean).join(' &middot; ')
  const caption = `Each bar is one measured configuration: <b>Qwen3.5-${CHART_SIZE.toUpperCase()}, reasoning on (rb=-1)</b>. KV-cache charts hold the weights at ${CHART_QUANT_HELD}; the quantization chart holds the KV-cache at ${CHART_KV_DEFAULT} (llama.cpp default). GPU and CPU are shown separately and never averaged; each metric's gpu/cpu pair shares one y-scale. Whiskers are &plusmn;1 stddev over 3 reps. A missing bar means that configuration crashed or is unsupported on that device. The full matrix and all model sizes are in the report tables.`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qwen3.5 Benchmark Charts</title></head><body style="max-width:920px;margin:24px auto;padding:0 16px;font-family:system-ui,Arial;color:#111827"><h1 style="font-size:20px;margin-bottom:2px">Qwen3.5 Benchmark Charts</h1><p style="color:#6b7280;margin-top:0">${metaBits}</p><p style="color:#374151">${caption}</p><div style="margin:8px 0 20px">${legend}</div>${charts || '<p>No mobile data to chart.</p>'}</body></html>`
}

function main () {
  const args = parseArgs(process.argv)

  const { rows, meta, desktopDevice } = loadDir(args.dir, args.desktopDevice)

  let baselineMap = null
  let baseline = null
  if (args.compareDir) {
    const { rows: baseRows, meta: baseMeta, desktopDevice: baselineDesktop } = loadDir(args.compareDir, desktopDevice)
    baselineMap = buildBaselineMap(baseRows)
    baseline = {
      rows: baseRows,
      meta: baseMeta,
      desktopDevice: baselineDesktop,
      runId: args.baselineRunId,
      runNumber: args.baselineRunNumber,
      runUrl: args.baselineRunUrl
    }
  }

  if (rows.length === 0) {
    // Metadata-only artifacts (run-meta/desktop-meta) are valid JSON but carry no
    // rows; the workflow's "any JSON present" precheck cannot tell them apart from
    // real results. Fail so a run that produced no benchmark data never renders as
    // a green, complete-looking report.
    const msg = 'No benchmark results found.\n'
    if (args.output) fs.writeFileSync(args.output, msg)
    else process.stdout.write(msg)
    process.exitCode = 1
    return
  }

  if (args.compareDir && baseline.rows.length === 0) {
    // A comparison was requested (compare_run_id) but the baseline produced no
    // benchmark rows (e.g. only run-meta/desktop-meta metadata was downloaded
    // for it). There is nothing to compare against, so fail rather than render a
    // delta-less report. This is distinct from a baseline that has rows but none
    // matching the current devices, which renders a per-device note instead.
    const msg = `No baseline benchmark data for the requested comparison (${args.compareDir}).\n`
    if (args.output) fs.writeFileSync(args.output, msg)
    else process.stdout.write(msg)
    process.exitCode = 1
    return
  }

  const md = render(rows, desktopDevice, meta, args.addonVersion, baselineMap, baseline, args.chartsUrl)
  if (args.output) fs.writeFileSync(args.output, md)
  else process.stdout.write(md)

  if (args.html) fs.writeFileSync(args.html, renderHtml(rows, desktopDevice, meta, args.addonVersion))
}

main()
