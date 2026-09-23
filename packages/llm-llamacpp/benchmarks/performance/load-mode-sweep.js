#!/usr/bin/env node
'use strict'

// Additive load-mode sweep: measures what each `load_mode` costs to load and to
// keep resident, per device, on this host.
//
// It is a node orchestrator rather than another bare case in
// llm-parameter-sweep.js because every measurement has to be its own process —
// see the header of load-mode-probe.js for the measurements that forced that.
// llm-parameter-sweep.js runs its whole grid in one bare process, which is
// correct for throughput (the quantity it measures) and wrong for load.
//
// A fresh process resets process state, NOT the OS page cache. After the first
// read of a model file every later process inherits a warm cache, so there is
// no per-cell "cold" load to report and none is claimed: one unmeasured
// warm-up per model puts every cell on the same warm-cache footing, and all
// samples are warm. Reporting a first-sample-per-cell figure as "cold" would
// label ordering as a property of the mode.
//
// Modes are rotated between repetitions rather than repeated back-to-back, so
// thermal drift and ordering spread across modes instead of landing on
// whichever one ran first.
//
// Rotation is WITHIN a device group, never across one. Interleaving an
// integrated-GPU cell with discrete-GPU cells put the device switch inside the
// measurement: the same integrated rows read ~1100 ms +/- 500 interleaved and
// 776-797 ms +/- 5-25 in a run of their own. So a sweep covering more than one
// main-gpu class runs each class as its own pass, and says so.

const { spawnSync } = require('node:child_process')
const nodeFs = require('node:fs')
const nodePath = require('node:path')
const nodeOs = require('node:os')

const {
  createLoadModeSweep,
  applyCliOverrides,
  buildLoadModeCells
} = require('./load-mode-sweep.config')

// Five, not three: the integrated GPU's intermittent stall hits roughly one
// sample in three, so a median of three can itself be decided by one stalled
// sample. Five keeps the median robust to a single outlier.
const DEFAULT_LOAD_REPEATS = 5
const MODELS_DIR = nodePath.resolve(__dirname, 'models')
const MANIFEST_PATH = nodePath.resolve(__dirname, 'models.manifest.json')
const RESOLVED_MODELS_PATH = nodePath.resolve(__dirname, 'resolved-models.json')

// The bare-side config reads these through bare-fs, which node cannot load, so
// the same two files are read here with node's fs rather than importing it.
function loadModelEntries () {
  const manifest = JSON.parse(nodeFs.readFileSync(MANIFEST_PATH, 'utf8'))
  const resolved = nodeFs.existsSync(RESOLVED_MODELS_PATH)
    ? JSON.parse(nodeFs.readFileSync(RESOLVED_MODELS_PATH, 'utf8'))
    : null

  return (manifest.models || []).map((model) => {
    const entry = resolved && resolved.models ? resolved.models[model.id] : null
    const quantizationFiles = {}
    if (entry && entry.gguf && entry.gguf.files) {
      for (const [quantization, localPath] of Object.entries(entry.gguf.files)) {
        quantizationFiles[quantization] = nodePath.basename(localPath)
      }
    }
    return { id: model.id, modelDir: MODELS_DIR, quantizationFiles }
  })
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const eqIdx = token.indexOf('=')
    if (eqIdx !== -1) {
      out[token.slice(2, eqIdx)] = token.slice(eqIdx + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

// Nulls are dropped rather than summed as zero, and an all-null input returns
// null. Without this, a platform with no /proc — darwin and win32 — averages
// [null, null, null] to 0 and the report presents "0 MiB anonymous" as a
// measurement: it would rank every mode as tied at zero anonymous memory
// instead of falling back to total rss, and would call an unverifiable mlock
// "lock had no effect" instead of "lock unverified". An absent counter has to
// stay absent all the way to the renderer.
function mean (values) {
  const nums = numeric(values)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

// The integrated GPU shows an intermittent multi-hundred-ms stall on the
// anonymous load path, hitting roughly one sample in three and moving between
// modes from run to run. A mean folds that outlier into the figure; the median
// of three does not. Both are reported, and a large mean-median gap is the
// signal that a cell was hit.
// All three aggregators drop nulls the same way, so a counter missing on one
// platform never becomes a number on the report.
function numeric (values) {
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v))
}

function median (values) {
  const sorted = numeric(values).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function stddev (values) {
  const nums = numeric(values)
  if (nums.length === 0) return null
  if (nums.length < 2) return 0
  const m = mean(nums)
  return Math.sqrt(nums.reduce((acc, v) => acc + (v - m) ** 2, 0) / (nums.length - 1))
}

function round (value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return null
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function mib (bytes) {
  if (bytes == null) return null
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

// How to invoke bare, resolved once by actually running each candidate.
//
// Three traps, all seen in CI:
//   - `bare` is on PATH on the linux-x64 runner and on dev machines, and is
//     NOT on darwin-x64 or linux-arm64 (run 35778027044: every cell ENOENT).
//   - On Windows the npm shims are .cmd, and since the CVE-2024-27980 fix Node
//     REFUSES to spawn a .bat/.cmd without a shell. Naming `bare.cmd` directly
//     does not help; the shim has to go through the command processor.
//     (run 35810927805: the npx fallback engaged and failed ENOENT anyway.)
//   - Through a command processor a missing inner command sets NO spawn error
//     and returns a non-zero status, so "no error" is not proof it ran.
// Hence: every candidate is a real invocation, selection requires a clean exit
// AND a version on stdout, and nothing runnable is a loud throw rather than
// letting every cell fail one at a time.
// `bare` is a dependency of this package, so `npm install` — which the
// workflow already runs here — puts it in node_modules/.bin. That local copy
// comes FIRST and is why npx is a last resort rather than the normal path:
// npx re-resolves the package on every invocation (~2s warm, far worse cold),
// and the sweep spawns one process per sample, which cost darwin-x64 40
// minutes for three cells in run 35810927805.
function localBinDir () {
  return nodePath.resolve(__dirname, 'node_modules', '.bin')
}

function bareCandidates (platform = process.platform, env = process.env, binDir = localBinDir()) {
  if (platform === 'win32') {
    const processor = env.ComSpec || 'cmd.exe'
    return [
      // Real executables can be spawned directly; npm shims cannot, and since
      // the CVE-2024-27980 fix Node refuses .cmd without a shell, so those go
      // through the command processor.
      { command: nodePath.join(binDir, 'bare.exe'), prefix: [] },
      { command: processor, prefix: ['/d', '/s', '/c', nodePath.join(binDir, 'bare.cmd')] },
      { command: 'bare.exe', prefix: [] },
      { command: processor, prefix: ['/d', '/s', '/c', 'bare.cmd'] },
      { command: processor, prefix: ['/d', '/s', '/c', 'npx.cmd', '--yes', 'bare'] }
    ]
  }
  return [
    { command: nodePath.join(binDir, 'bare'), prefix: [] },
    { command: 'bare', prefix: [] },
    // Last resort: what the workflow uses for llm-parameter-sweep.js.
    { command: 'npx', prefix: ['--yes', 'bare'] }
  ]
}

// Picks the first candidate that genuinely executes. Separate from the memo so
// tests can drive it with injected candidates and assert on real execution
// rather than on how the list was spelled.
function resolveBareCommand (candidates = bareCandidates()) {
  const tried = []
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '--version'], { encoding: 'utf8' })
    const label = [candidate.command, ...candidate.prefix].join(' ')
    if (probe.error) {
      tried.push(`${label} (${probe.error.code || probe.error.message})`)
      continue
    }
    // A processor runs even when the thing it was asked to run does not, so a
    // clean spawn is not enough — require the exit status AND real output.
    // The two are reported separately: collapsing them once claimed "no
    // version output" for a candidate that had printed some.
    const version = (probe.stdout || '').trim()
    if (probe.status !== 0) {
      tried.push(`${label} (exit ${probe.status}${version ? '' : ', no output'})`)
      continue
    }
    if (!version) {
      tried.push(`${label} (exit 0 but printed no version)`)
      continue
    }
    return { candidate, version }
  }
  throw new Error(
    'Cannot invoke bare. Tried: ' + tried.join('; ') +
    '. Install bare on PATH or make npx available on this runner.'
  )
}

let _bareCommand = null
function bareCommand () {
  if (_bareCommand) return _bareCommand
  const { candidate, version } = resolveBareCommand()
  _bareCommand = candidate
  console.log(`bare invocation: \`${[candidate.command, ...candidate.prefix].join(' ')}\` (${version})`)
  return _bareCommand
}

// Does this record carry a measurement anyone can use?
//
// Not the same question as "did the probe exit cleanly". A cell that requested
// the GPU and silently ran on the CPU loaded fine and reports a time, but the
// renderer already marks it "not a comparable row" — counting it as data would
// let an all-GPU leg that quietly fell back to CPU pass the no-data guard while
// producing nothing the report can use.
function isUsableRecord (r) {
  if (r.status === 'failed') return false
  if (r.loadMsMedian == null) return false
  if (!r.backendDevice) return false
  if (r.requestedDevice && r.backendDevice !== r.requestedDevice) return false
  return true
}

// Why a probe produced nothing.
//
// result.error carries spawn-level failures (ENOENT, EACCES), and for those
// stderr is undefined and status is null — so a message built only from the
// stderr tail reads "probe produced no result (exit null): " and names nothing.
// Two CI legs failed exactly that way and the artifacts could not say why.
function describeProbeFailure (result) {
  const stderrTail = (result.stderr || '').trim().split('\n').slice(-3).join(' | ')
  const spawnError = result.error ? `${result.error.code || result.error.message}: ` : ''
  return `${spawnError}probe produced no result (exit ${result.status}): ${stderrTail}`
}

// One measurement = one process. Returns the probe's parsed JSON, or a failure
// record carrying whatever the probe managed to say.
function runProbe (modelPath, config, addonSource, tmpDir, label) {
  const configPath = nodePath.join(tmpDir, `config-${label}.json`)
  nodeFs.writeFileSync(configPath, JSON.stringify(config))
  const { command, prefix } = bareCommand()
  const result = spawnSync(
    command,
    [
      ...prefix,
      nodePath.resolve(__dirname, 'load-mode-probe.js'),
      '--model', modelPath,
      '--config', configPath,
      '--addon-source', addonSource
    ],
    { cwd: __dirname, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 }
  )

  const stdout = result.stdout || ''
  // The engine writes a lot to stdout before our line; take the last JSON object.
  const jsonLine = stdout
    .split('\n')
    .reverse()
    .find((line) => line.trim().startsWith('{') && line.includes('"ok"'))

  if (!jsonLine) return { ok: false, error: describeProbeFailure(result) }
  try {
    return JSON.parse(jsonLine)
  } catch (err) {
    return { ok: false, error: `unparseable probe output: ${err.message}` }
  }
}

function classify (cell, loadSamples, backendDevice) {
  if (loadSamples.length === 0) return 'failed'
  // A cell that asked for one device and ran on another measured something
  // real, but not the thing it was asked to measure. Calling it 'measured'
  // would let a GPU-less runner publish CPU timings under a GPU heading, so
  // it gets its own status and is excluded from the usable-record count.
  if (backendDevice && backendDevice !== cell.device) return 'backend-mismatch'
  // Unknown is NOT the same as matching. The probe reports null whenever its
  // verification inference does not return stats — which is every cell on
  // darwin-x64 in run 35810927805 — and treating that as agreement published
  // a GPU-labelled row with no evidence any GPU ran. A device verdict needs a
  // confirmed device, so this is its own status and is not usable data.
  if (!backendDevice) return 'backend-unverified'
  // dio is accepted by the addon but never reaches the file open in fabric
  // (llama-model-load.cpp drops use_direct_io), so it cannot be distinguished
  // from `none` by measurement. Say so rather than reporting a phantom margin.
  if (cell.mode === 'dio') return 'inert'
  return 'measured'
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const addonSource = typeof args['addon-source'] === 'string' ? args['addon-source'] : 'local'
  const loadRepeats = args['load-repeats'] ? Number(args['load-repeats']) : DEFAULT_LOAD_REPEATS
  const resultsDir = args['results-dir']
    ? nodePath.resolve(args['results-dir'])
    : nodePath.resolve(__dirname, 'results', 'load-mode')
  const sweep = applyCliOverrides(createLoadModeSweep(process.platform), args)

  const allModels = loadModelEntries()
  const selectedModelIds = args.models
    ? String(args.models).split(',').map((x) => x.trim()).filter(Boolean)
    : allModels.map((m) => m.id)
  const selectedModels = allModels.filter((m) => selectedModelIds.includes(m.id))
  if (selectedModels.length === 0) {
    throw new Error(`No matching models for --models=${selectedModelIds.join(',')}`)
  }

  nodeFs.mkdirSync(resultsDir, { recursive: true })
  const tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'qvac-load-mode-'))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonlPath = nodePath.join(resultsDir, `load-mode-sweep-${stamp}.jsonl`)
  const mdPath = nodePath.join(resultsDir, `load-mode-sweep-${stamp}.md`)
  nodeFs.writeFileSync(jsonlPath, '')

  const cells = buildLoadModeCells(selectedModels, sweep)

  console.log(`load-mode sweep: ${cells.length} cells x ${loadRepeats} loads, one process each`)
  console.log(`addon source: ${addonSource}`)
  console.log(`results: ${jsonlPath}`)

  // String-valued config: the addon's load-config parser takes strings.
  const stringify = (config) => {
    const out = {}
    for (const [k, v] of Object.entries(config)) {
      if (v === null || v === undefined) continue
      out[k] = String(v)
    }
    return out
  }

  const runnable = cells.filter((cell) => {
    const exists = nodeFs.existsSync(nodePath.join(cell.modelDir, cell.modelName))
    if (!exists) console.log(`SKIPPED (model missing): ${cell.caseId}`)
    return exists
  })

  // One unmeasured warm-up per distinct model file, so the first measured
  // sample of the first mode is not paying for a cold page cache that none of
  // the later modes pay.
  const warmed = new Set()
  for (const cell of runnable) {
    const modelPath = nodePath.join(cell.modelDir, cell.modelName)
    if (warmed.has(modelPath)) continue
    warmed.add(modelPath)
    console.log(`warm-up (not measured): ${cell.modelName}`)
    runProbe(modelPath, stringify(cell.config), addonSource, tmpDir, 'warmup')
  }

  // One pass per device class, rotating modes inside it. Grouping by the
  // device keeps the GPU switch out of the measurement (see header).
  const groupKey = (cell) => `${cell.modelName}|${cell.device}|${cell.mainGpu || 'default'}`
  const groups = new Map()
  for (const cell of runnable) {
    const key = groupKey(cell)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(cell)
  }
  if (groups.size > 1) {
    console.log(`${groups.size} device groups; each runs as its own pass`)
  }

  const samples = new Map(runnable.map((cell) => [cell.caseId, []]))
  const failures = new Map()
  for (const [key, groupCells] of groups) {
    for (let repeat = 0; repeat < loadRepeats; repeat++) {
      // Rotate which mode goes first, so a fixed position cannot become a
      // property of a mode. This is hygiene, not a fix for anything measured:
      // an earlier reading blamed the integrated GPU's spread on whichever
      // mode sorted first, and rotating disproved it — the spread moved
      // between modes instead of going away. See `median` below for what the
      // spread actually needed.
      const order = groupCells.map((_, idx) => groupCells[(idx + repeat) % groupCells.length])
      for (const cell of order) {
        if (failures.has(cell.caseId)) continue
        const modelPath = nodePath.join(cell.modelDir, cell.modelName)
        const probe = runProbe(modelPath, stringify(cell.config), addonSource, tmpDir, `${cell.caseId}-${repeat}`)
        if (!probe.ok) {
          failures.set(cell.caseId, probe.error)
          continue
        }
        samples.get(cell.caseId).push(probe)
      }
      console.log(`${key}: repetition ${repeat + 1}/${loadRepeats} complete`)
    }
  }

  const records = []
  for (let i = 0; i < runnable.length; i++) {
    const cell = runnable[i]
    const cellSamples = samples.get(cell.caseId)
    const failure = failures.get(cell.caseId) || null
    const loadSamples = cellSamples.map((s) => s.loadMs)
    // Every sample is its own process, so every delta has a clean baseline and
    // all of them are aggregated — no single sample stands in for the cell.
    const memory = cellSamples.length > 0
      ? {
          rssBytes: mean(cellSamples.map((s) => s.delta.rssBytes)),
          rssAnonBytes: mean(cellSamples.map((s) => s.delta.rssAnonBytes)),
          rssFileBytes: mean(cellSamples.map((s) => s.delta.rssFileBytes)),
          lockedBytes: mean(cellSamples.map((s) => s.delta.lockedBytes)),
          retained: mean(cellSamples.map((s) =>
            s.absolute.afterUnload.file == null ? null : s.absolute.afterUnload.file - s.absolute.before.file))
        }
      : null
    const backendDevices = [...new Set(cellSamples.map((s) => s.backendDevice).filter(Boolean))]

    const resolvedBackend = backendDevices.length === 1 ? backendDevices[0] : null
    const status = failure ? 'failed' : classify(cell, loadSamples, resolvedBackend)
    const record = {
      caseId: cell.caseId,
      modelId: cell.modelId,
      quantization: cell.quantization,
      device: cell.device,
      mainGpu: cell.mainGpu,
      loadMode: cell.mode,
      status,
      // The backend the engine reported actually executing on. An explicit
      // main-gpu naming a class this host lacks silently falls back to the CPU,
      // so a row whose backendDevice disagrees with its requested device is a
      // mislabelled measurement, not a result.
      backendDevice: backendDevices.length === 1 ? backendDevices[0] : backendDevices.join('/') || null,
      requestedDevice: cell.device,
      loadMsMedian: round(median(loadSamples)),
      loadMsMean: round(mean(loadSamples)),
      loadMsStd: round(stddev(loadSamples)),
      loadSamples: loadSamples.map((v) => round(v)),
      rssBytes: memory ? memory.rssBytes : null,
      rssAnonBytes: memory ? memory.rssAnonBytes : null,
      rssFileBytes: memory ? memory.rssFileBytes : null,
      lockedBytes: memory ? memory.lockedBytes : null,
      retainedAfterUnloadBytes: memory ? memory.retained : null,
      error: failure
    }
    records.push(record)
    nodeFs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`)

    const mismatch = record.backendDevice && record.backendDevice !== cell.device
    console.log(
      `[${i + 1}/${runnable.length}] ${cell.mode.padEnd(10)} ` +
      `${(cell.mainGpu || cell.device).padEnd(10)} q=${cell.quantization.padEnd(6)} ` +
      (failure
        ? `FAILED ${failure}`
        : `load med ${round(median(loadSamples))}ms (mean ${round(mean(loadSamples))}±${round(stddev(loadSamples))}) ` +
          `rss ${mib(record.rssBytes)}MiB anon ${mib(record.rssAnonBytes)}MiB file ${mib(record.rssFileBytes)}MiB ` +
          `backend=${record.backendDevice || '?'}` +
          (mismatch ? '  ** requested ' + cell.device + ', ran on ' + record.backendDevice + ' **' : ''))
    )
  }

  // A .json in the shape render-report.js already understands, so the
  // summarize job picks desktop load-mode results up with everything else.
  // The .jsonl and .md above are the raw record and a standalone read; neither
  // is parsed by the renderer, which reads only .json — writing only those two
  // would upload the results and have the GitHub summary silently omit them.
  //
  // `device` carries this leg's own platform identity rather than relying on
  // the global desktopDevice stamp: a multi-platform desktop matrix writes one
  // desktop-meta.json per leg and the renderer keeps the first it finds, so
  // every leg's rows would otherwise be labelled with one platform's name.
  const platform = args.platform || `${process.platform}-${process.arch}`
  const reportPath = nodePath.join(resultsDir, `load-mode-perf-${platform}-${stamp}.json`)
  nodeFs.writeFileSync(reportPath, JSON.stringify({
    device: { name: `Desktop ${platform}` },
    // Marks these rows as desktop regardless of what the device name happens
    // to be. Name-matching against the global desktopDevice stamp does not
    // work: the stamp carries the detected GPU ("Desktop linux-x64 (RTX
    // 5080)") and this name does not, so the two never compare equal.
    desktop: true,
    addon: 'llamacpp-llm',
    results: records
      .filter((r) => r.status !== 'failed' || r.error)
      .map((r) => ({
        // The label the renderer parses back into a shard key and a
        // load-mode row: same [model] [backend] [kv=] [lm=] grammar the
        // mobile reporter emits.
        test:
          `[${r.modelId}-${r.quantization}] [${r.backendDevice || r.requestedDevice}] ` +
          `[rb=-1] [kv=f16] [lm=${r.loadMode}]` +
          (r.mainGpu ? ` [mg=${r.mainGpu}]` : ''),
        status: r.status === 'failed' ? 'crashed' : 'passed',
        metrics: {
          ttft_ms: null,
          tps: null,
          pp_tps: null,
          generated_tokens: null,
          // Median, not mean: an intermittent stall inflates the mean and
          // would be reported as the mode's cost (see this file's header).
          load_ms: r.loadMsMedian,
          rss_bytes: r.rssBytes,
          rss_anon_bytes: r.rssAnonBytes,
          rss_file_bytes: r.rssFileBytes,
          locked_bytes: r.lockedBytes
        }
      }))
  }, null, 2))

  nodeFs.writeFileSync(mdPath, renderMarkdown(records, addonSource, loadRepeats))
  console.log(`wrote ${reportPath}`)
  nodeFs.rmSync(tmpDir, { recursive: true, force: true })
  console.log(`\nwrote ${mdPath}`)

  // A mode that cannot load is a legitimate result and stays a `failed` row.
  // A leg where NOTHING loaded is not data, it is a broken runner, and it must
  // not report success: darwin-x64 and linux-arm64 both went green on 0/18 in
  // run 35778027044, and the artifacts looked like real (empty) reports.
  const measured = records.filter(isUsableRecord)
  if (measured.length === 0) {
    console.error(`\nload-mode sweep: 0 of ${records.length} cells produced a usable measurement — no data.`)
    process.exitCode = 1
  }
}

// Grouped by the thing that decides the answer: the device the load targets.
// Margins are against `auto`, the addon's default, and against `mmap`, which is
// what the ticket's acceptance criteria name.
function renderMarkdown (records, addonSource, loadRepeats) {
  const lines = []
  lines.push('# load_mode sweep')
  lines.push('')
  lines.push(`Addon source: \`${addonSource}\`. ${loadRepeats} samples per cell, each in its own process,`)
  lines.push('with modes rotated between repetitions and one unmeasured warm-up per model.')
  lines.push('')
  lines.push('Every sample is a fresh process: a second load in the same process cannot be measured')
  lines.push('(see `load-mode-probe.js`). All samples are warm-cache — a fresh process does not reset')
  lines.push('the page cache, so no cold-load figure is claimed. Memory is the mean delta across samples.')
  lines.push('')

  const groups = new Map()
  for (const r of records) {
    const key = `${r.modelId} | q=${r.quantization} | ${r.device}${r.mainGpu ? ` (${r.mainGpu})` : ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  for (const [key, rows] of groups) {
    lines.push(`## ${key}`)
    lines.push('')
    lines.push('| mode | status | backend | load ms (median) | mean ± σ | samples | Δ vs auto | Δ vs mmap | rss MiB | anon MiB | file MiB | locked MiB |')
    lines.push('|------|--------|---------|------------------|----------|---------|-----------|-----------|---------|----------|----------|------------|')
    const auto = rows.find((r) => r.loadMode === 'auto')
    const mmapRow = rows.find((r) => r.loadMode === 'mmap')
    // Margins are computed from medians: an outlier-contaminated mean would
    // report a stall as a property of the mode.
    const pct = (ref, r) => (ref && ref.loadMsMedian && r.loadMsMedian
      ? `${r.loadMsMedian >= ref.loadMsMedian ? '+' : ''}${round(((r.loadMsMedian / ref.loadMsMedian) - 1) * 100)}%`
      : '—')
    for (const r of rows) {
      lines.push(
        `| \`${r.loadMode}\` | ${r.status} | ${r.backendDevice || '?'} | ` +
        `**${r.loadMsMedian ?? '—'}** | ${r.loadMsMean ?? '—'} ± ${r.loadMsStd ?? '—'} | ` +
        `${(r.loadSamples || []).join(', ')} | ${pct(auto, r)} | ${pct(mmapRow, r)} | ` +
        `${mib(r.rssBytes) ?? '—'} | ${mib(r.rssAnonBytes) ?? '—'} | ${mib(r.rssFileBytes) ?? '—'} | ` +
        `${mib(r.lockedBytes) ?? '—'} |`
      )
    }
    lines.push('')
    // Two metrics, two winners. Naming one overall "best" would hide the case
    // where the fastest mode is not the leanest — which is exactly the
    // trade-off an integrated GPU presents.
    // 'inert' rows are aliases of another mode (dio behaves as none), so they
    // are reported but never nominated as a winner — crowning an alias would
    // read as a recommendation to set a flag that does nothing.
    const ok = rows.filter((r) => r.status === 'measured' && r.loadMsMean != null)
    if (ok.length > 0) {
      const fastest = ok.reduce((a, b) => (b.loadMsMedian < a.loadMsMedian ? b : a))
      const memMetric = (r) => (r.rssAnonBytes != null && r.rssFileBytes != null
        ? Math.max(r.rssAnonBytes, r.rssFileBytes) : r.rssBytes)
      const withMem = ok.filter((r) => memMetric(r) != null)
      const leanest = withMem.length > 0
        ? withMem.reduce((a, b) => (memMetric(b) < memMetric(a) ? b : a))
        : null
      // A margin inside the samples' own spread is not a ranking. Modes whose
      // means sit within a pooled sigma of the winner are named alongside it.
      const near = (r, ref) => Math.abs(r.loadMsMedian - ref.loadMsMedian) <= (r.loadMsStd || 0) + (ref.loadMsStd || 0)
      const tiedFast = ok.filter((r) => r !== fastest && near(r, fastest))
      lines.push(
        `- fastest load: \`${fastest.loadMode}\` (median ${fastest.loadMsMedian} ms)` +
        (tiedFast.length > 0 ? `, tied within spread with ${tiedFast.map((r) => '`' + r.loadMode + '`').join(', ')}` : '')
      )
      if (leanest) lines.push(`- lowest resident: \`${leanest.loadMode}\` (rss ${mib(leanest.rssBytes)} MiB)`)
      // A mean well above the median means at least one sample stalled. The
      // median still stands; the mean should not be quoted for that cell.
      const stalled = ok.filter((r) => r.loadMsMedian > 0 && r.loadMsMean / r.loadMsMedian > 1.15)
      if (stalled.length > 0) {
        lines.push(
          `- ⚠ at least one stalled sample on ${stalled.map((r) => '`' + r.loadMode + '`').join(', ')} ` +
          '(mean >15% above median) — read the median, not the mean, for those rows.'
        )
      }
      if (leanest && leanest.loadMode !== fastest.loadMode) {
        lines.push('- **no single winner**: the fastest mode is not the leanest; state the trade-off rather than picking one.')
      }
      const mislabelled = rows.filter((r) => r.backendDevice && r.backendDevice !== r.requestedDevice)
      for (const r of mislabelled) {
        lines.push(`- ⚠ \`${r.loadMode}\` requested \`${r.requestedDevice}\` but ran on \`${r.backendDevice}\` — not a comparable row.`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

main()
