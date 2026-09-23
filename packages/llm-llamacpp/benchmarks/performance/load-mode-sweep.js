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
    // `next === undefined` means the flag ended the argv; an EMPTY STRING is a
    // real value. Treating '' as absent turned `--sweep-params ""` — what the
    // workflow passes whenever the input is left at its default — into the
    // boolean true, which then failed validation as an unknown param and broke
    // the default dispatch of the existing throughput benchmark.
    if (next === undefined || next.startsWith('--')) {
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

// How to invoke bare. CI installs a global bare via setup-bare-tooling, so the
// normal path is simply `bare`; npx remains for a local shell without one.
//
// Selection runs the candidate rather than trusting the name: on Windows the
// npm shims are .cmd and, since the CVE-2024-27980 fix, Node refuses to spawn
// a .bat/.cmd without a shell, so those go through the command processor — and
// through a processor a missing inner command sets no spawn error and exits
// non-zero, which is why a clean spawn alone is not proof it ran.
function bareCandidates (platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const processor = env.ComSpec || 'cmd.exe'
    return [
      { command: 'bare.exe', prefix: [] },
      { command: processor, prefix: ['/d', '/s', '/c', 'bare.cmd'] },
      { command: processor, prefix: ['/d', '/s', '/c', 'npx.cmd', '--yes', 'bare'] }
    ]
  }
  return [
    { command: 'bare', prefix: [] },
    { command: 'npx', prefix: ['--yes', 'bare'] }
  ]
}

function resolveBareCommand (candidates = bareCandidates()) {
  const tried = []
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '--version'], { encoding: 'utf8' })
    const label = [candidate.command, ...candidate.prefix].join(' ')
    if (probe.error) {
      tried.push(`${label} (${probe.error.code || probe.error.message})`)
      continue
    }
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
    '. CI installs one via .github/actions/setup-bare-tooling; locally, install bare or make npx available.'
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
// let a leg that quietly fell back to another device pass the no-data guard while
// producing nothing the report can use.
function isUsableRecord (r) {
  if (r.status === 'failed') return false
  if (r.status === 'backend-probe-failed') return false
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

function classify (cell, loadSamples, backendDevice, probeError) {
  if (loadSamples.length === 0) return 'failed'
  // The probe threw. That is a harness fault, not a property of the platform,
  // and it must not be reported as "this device cannot say which backend ran"
  // — an invalid generation param once masqueraded as exactly that.
  if (probeError) return 'backend-probe-failed'
  // A cell that asked for one device and ran on another measured something
  // real, but not the thing it was asked to measure. Calling it 'measured'
  // would let a GPU-less runner publish CPU timings under a GPU heading, so
  // it gets its own status and is excluded from the usable-record count.
  if (backendDevice && backendDevice !== cell.device) return 'backend-mismatch'
  // Unknown is NOT the same as matching. The probe reports null whenever its
  // verification inference returns no stats, and treating that as agreement
  // publishes a device-labelled row with no evidence that device ran.
  // A device verdict needs a
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
    const probeError = cellSamples.map((sp) => sp.backendProbeError).find(Boolean) || null
    const status = failure ? 'failed' : classify(cell, loadSamples, resolvedBackend, probeError)
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
      // WHY the probe failed, not just that it did. Carrying only the status
      // left `backend-probe-failed` rows in the artifact with no way to tell
      // a harness bug from a platform limitation without the job log.
      backendProbeError: probeError,
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
        // Labelled with the REQUESTED device, so rows group by what was asked
        // for. What actually ran travels beside it in execution_provider and
        // the renderer compares the two. Labelling with the observed backend
        // and falling back to the requested one when it was unknown made an
        // unverified CPU fallback indistinguishable from a real GPU row.
        test:
          `[${r.modelId}-${r.quantization}] [${r.requestedDevice}] ` +
          `[rb=-1] [kv=f16] [lm=${r.loadMode}]` +
          (r.mainGpu ? ` [mg=${r.mainGpu}]` : ''),
        // A thrown probe is a harness failure, not a measurement, and is
        // reported as crashed. Emitting it as passed would leave it with a
        // null execution_provider, which the renderer would show as
        // "Backend unverified" — indistinguishable from a platform that
        // genuinely cannot report its backend.
        status:
          r.status === 'failed' || r.status === 'backend-probe-failed'
            ? 'crashed'
            : 'passed',
        // Observed backend ONLY — null when the probe could not establish it.
        // Never falls back to the request; that is the whole point.
        execution_provider: r.backendDevice || null,
        requested_device: r.requestedDevice,
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

  console.log(`wrote ${reportPath}`)
  nodeFs.rmSync(tmpDir, { recursive: true, force: true })

  // A mode that cannot load is a legitimate result and stays a `failed` row.
  // A leg where NOTHING loaded is not data, it is a broken runner, and it must
  // not report success — the artifacts of such a leg still look like
  // well-formed (empty) reports.
  const measured = records.filter(isUsableRecord)
  if (measured.length === 0) {
    console.error(`\nload-mode sweep: 0 of ${records.length} cells produced a usable measurement — no data.`)
    process.exitCode = 1
  }
}


main()
