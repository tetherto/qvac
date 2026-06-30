'use strict'
// VLM benchmark harness. Loops the fixture (fixture.data.cjs) for one
// cell and emits one [VLMROW]{json}[/VLMROW] marker per sample. The SAME code runs
// from this dir on Linux (the workflow points brittle straight here) and from a
// staged copy in test/integration on the mobile Device Farm path; host-side
// aggregate.js parses the markers into quality + speed matrices.
//
// Both this dir and test/integration are 2 levels under packages/llm-llamacpp, so the
// ../../-relative requires below resolve identically from either location.
//
// HEADLINE METRIC: mmproj/vision-encode time. The addon emits `image slice encoded in
// N ms` on native stderr at verbosity=2; aggregate.js sums them across tiles.
//
// Gated by QVAC_VLM_MATRIX=1 so model downloads never fire during the normal
// integration suite — only the benchmark workflow sets it (mobile is always enabled).

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { ensureModel } = require('../../test/integration/utils')
const LlmLlamacpp = require('../../index.js')
const fixture = require('./fixture.data.cjs')
const config = require('./config.cjs')
const { parseModels } = require('./models.cjs')
const { stabilityGuard } = require('./methodology.cjs')

// Resolve a fixture image. Images live in a fixture object store (not git): CI syncs
// them into this dir's fixture/ before the run. Desktop reads fixture/ directly; mobile
// uses the bundled asset manifest (stage.cjs copies fixture/ -> test/mobile/testAssets
// after that sync).
function getMediaPath (filename) {
  if ((os.platform() === 'ios' || os.platform() === 'android') && global.assetPaths) {
    const key = `../../testAssets/${filename}`
    if (global.assetPaths[key]) return global.assetPaths[key].replace('file://', '')
    throw new Error(`Asset not found in testAssets: ${filename} (rebuild the app)`)
  }
  return path.join(__dirname, 'fixture', filename)
}

function env (key) {
  if (typeof os.getEnv === 'function') return os.getEnv(key) || ''
  if (typeof process !== 'undefined' && process.env) return process.env[key] || ''
  return ''
}
const isMobile = os.platform() === 'android' || os.platform() === 'ios'
// On mobile the matrix is selected explicitly via test-groups + perf-tests, so enable
// it there; on desktop gate behind QVAC_VLM_MATRIX so the normal suite skips the 6 GB.
const ENABLED = isMobile || env('QVAC_VLM_MATRIX') === '1'
function intEnv (k) { const v = parseInt(env(k), 10); return Number.isFinite(v) && v > 0 ? v : null }
// Like intEnv but allows 0 (block 0 = warmup, model index 0 are both valid).
function nonNegEnv (k) { const raw = env(k); if (raw === '') return null; const v = parseInt(raw, 10); return Number.isFinite(v) && v >= 0 ? v : null }

// Active preset = the run SIZE (tasks × samples × repeats), independent of mode.
// QVAC_VLM_PRESET overrides config.defaultPreset on every target — the workflow sets
// it directly on desktop and forwards it to phones via the pushed device config
// (os.setEnv before this module loads). An unknown name fails loudly rather than
// silently running an empty default (a typo would otherwise run "everything").
const PRESET_NAME = env('QVAC_VLM_PRESET') || config.defaultPreset
const PRESET = config.presets[PRESET_NAME]
if (!PRESET) {
  throw new Error(`unknown preset '${PRESET_NAME}' (known: ${Object.keys(config.presets).join(', ')})`)
}

// Comparison mode + this run's engine. In 'several-sources' the comparison axis is
// the engine (this addon leg is one of addon/fabric-cli/upstream-cli), so markers are
// keyed by the source label instead of the model label. Driven by env on desktop.
const MODE = env('QVAC_VLM_MODE') || config.mode || 'two-models'
const SOURCE = env('QVAC_VLM_ENGINE') || config.engine || 'addon'

// Active scenario (CONTRACT.md §2): the workload definition — its task list is
// the task universe for this run. The runner executes the FIRST CSV token;
// multi-scenario runs are reserved. Unknown/fixtureless scenarios fail fast.
const SCENARIO_ID = (env('QVAC_VLM_SCENARIOS') || config.defaultScenario || 'default')
  .split(',')[0].trim()
const SCENARIO = (config.scenarios || {})[SCENARIO_ID]
if (!SCENARIO) throw new Error(`unknown scenario '${SCENARIO_ID}' (known: ${Object.keys(config.scenarios || {}).join(', ')})`)
if (SCENARIO.fixturePending) throw new Error(`scenario '${SCENARIO_ID}' has no fixture yet`)

// Source identity stamped into every marker (CONTRACT.md §1): which build
// produced the numbers. The workflow leg sets these; sensible fallbacks here.
const SRC_ID = env('QVAC_VLM_SOURCE_ID') || (MODE === 'several-sources' ? SOURCE : 'addon')
const SRC_REF = env('QVAC_VLM_SOURCE_REF') || ''

// samples/task precedence: explicit env > preset > (mobile 2 / desktop 5). Mobile
// defaults low to fit the 30-min Device Farm ceiling; qvac_perf_runs lands here.
const SAMPLES_PER_TASK = intEnv('QVAC_VLM_SAMPLES') || intEnv('QVAC_PERF_RUNS') ||
  PRESET.samplesPerTask || (isMobile ? 2 : 5)

// Repeats per (sample): each inference is run N times so the report's timings are a
// mean over repeats and any nondeterminism is visible. Default 3 on desktop; 1 on
// mobile to stay under the Device Farm ceiling. Override with QVAC_VLM_REPEATS.
const REPEATS = intEnv('QVAC_VLM_REPEATS') || PRESET.repeats || (isMobile ? 1 : 3)

// Per-test bare-runner ceiling (minutes) for the whole vlm-matrix test on one device.
// Large models on slow CPUs / phones can exceed the default 30 min and get cut off mid
// run (partial markers). QVAC_VLM_TEST_TIMEOUT_MIN raises it in step with the workflow's
// mobile_timeout_min. Absent/empty = 30, identical to the original hardcoded ceiling.
const TEST_TIMEOUT_MIN = intEnv('QVAC_VLM_TEST_TIMEOUT_MIN') || 30

// Stability: set by the (future) desktop round scheduler when it drives one block
// per process — the block number to stamp (0 = warmup, 1.. = measured), the model
// index to pin, and the prebuild backends dir. All absent on single-process / mobile
// runs (our model), where the harness does its OWN warmup (WARMUP_REPEATS below).
const BLOCK_OVERRIDE = nonNegEnv('QVAC_VLM_BLOCK')
const MODEL_INDEX = nonNegEnv('QVAC_VLM_MODEL_INDEX')
const BACKENDS_DIR = env('QVAC_VLM_BACKENDS_DIR')

// Warmup passes run before the measured ones to prime weights/caches and let the
// machine reach a steady thermal state — most important on phones, which throttle
// hard. Stamped block 0 (the report drops block 0 from stats). When the desktop
// scheduler owns blocks across processes (BLOCK_OVERRIDE set) this is 0; otherwise
// (mobile + desktop-direct) default 1. Override with QVAC_VLM_WARMUP_REPEATS.
const WARMUP_REPEATS = BLOCK_OVERRIDE != null
  ? 0
  : (nonNegEnv('QVAC_VLM_WARMUP_REPEATS') != null ? nonNegEnv('QVAC_VLM_WARMUP_REPEATS') : 1)

// tasks: QVAC_VLM_TASKS (csv) > preset.tasks > the scenario's task list.
// preset.maxTasks (e.g. smoke = 1) trims to the first N distinct tasks so the
// preset stays scenario-agnostic.
const TASKS = (() => {
  const raw = env('QVAC_VLM_TASKS')
  if (raw) return raw.split(',').map(s => s.trim()).filter(Boolean)
  return PRESET.tasks || SCENARIO.tasks || null
})()

// Output token cap per task. ocr-page transcribes a whole document, so it needs far more
// than a VQA answer; the run's cap is the max over its selected tasks. It's a CAP, not a
// forced length — short answers still stop at EOS, so VQA pays nothing for the headroom.
const TASK_NPREDICT = { 'ocr-page': 768, 'ocr-small': 96 }
const DEFAULT_NPREDICT = 128
// Scored-prediction char cap. Full-page OCR is a whole-document transcription (golds up
// to ~1.5k chars), so it needs a wide cap or CER/WER are inflated by truncation alone;
// every other task is a short answer — keep those tight so the [VLMROW] marker stays well
// under Android logcat's ~4 KB per-line limit (over-long markers get truncated on-device).
const TASK_PRED_CAP = { 'ocr-page': 2000 }
const DEFAULT_PRED_CAP = 600
const predCap = task => TASK_PRED_CAP[task] || DEFAULT_PRED_CAP

function selectedItems () {
  // Explicit item allowlist (preset.ids) wins — used to pick specific images
  // (e.g. ocr1page = just ocr-page_0; ocr5pages = all 5 ocr-page docs).
  if (PRESET.ids) { const want = new Set(PRESET.ids); return fixture.items.filter(it => want.has(it.id)) }
  const seen = {}
  return fixture.items.filter(it => {
    if (TASKS && !TASKS.includes(it.task)) return false
    if (!(it.task in seen) && PRESET.maxTasks && Object.keys(seen).length >= PRESET.maxTasks) return false
    seen[it.task] = (seen[it.task] || 0) + 1
    // per-task sample cap (preset.taskSamples) overrides the global samplesPerTask
    const cap = (PRESET.taskSamples && PRESET.taskSamples[it.task] != null) ? PRESET.taskSamples[it.task] : SAMPLES_PER_TASK
    return seen[it.task] <= cap
  })
}

// The models under test (each = main LLM blob + mmproj blob + source descriptors)
// live in config.cjs. The harness only resolves descriptors to concrete files.
const HF = (repo, sha, file) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`

// Map a blob's `source` descriptor to a download plan ensureBlob() can act on:
//   { modelName, downloadUrl }     — HTTP(S): hf / url / s3 (presigned)
//   { modelName, fetch(destPath) } — custom downloader: registry (P2P)
// A literal `downloadUrl` on the blob (legacy shape) still wins.
function resolveBlob (blob) {
  if (blob.downloadUrl) return { modelName: blob.modelName, downloadUrl: blob.downloadUrl }
  const s = blob.source || {}
  switch (s.type) {
    case 'hf':
      return { modelName: blob.modelName, downloadUrl: HF(s.repo, s.sha, s.file) }
    case 'url':
    case 's3': // S3 objects are fetched via a presigned URL (no SigV4 signing here)
      if (!s.url) throw new Error(`${blob.modelName}: source.type='${s.type}' requires source.url`)
      return { modelName: blob.modelName, downloadUrl: s.url }
    case 'registry':
      return { modelName: blob.modelName, fetch: (destPath) => fetchFromRegistry(s, destPath) }
    default:
      throw new Error(`${blob.modelName}: unknown source.type '${s.type}'`)
  }
}

// QVAC registry is a P2P (Hyperswarm/Hyperblobs) store, not an HTTP endpoint, so it
// needs @qvac/registry-client + QVAC_REGISTRY_CORE_KEY. Lazily required so the
// hf/url/s3 paths never depend on it; throws a clear error when unavailable.
async function fetchFromRegistry (source, destPath) {
  const coreKey = env('QVAC_REGISTRY_CORE_KEY')
  if (!coreKey) throw new Error('registry source requires QVAC_REGISTRY_CORE_KEY')
  let QVACRegistryClient
  // Indirect the specifier so the mobile static bundler doesn't try to resolve
  // this optional P2P dep (only needed for registry sources on Linux/desktop;
  // a literal require() makes `npm run bundle` bail with MODULE_NOT_FOUND).
  const pkg = '@qvac/registry-client'
  try { ({ QVACRegistryClient } = require(pkg)) } catch (_) {
    throw new Error("registry source requires '@qvac/registry-client' (not installed)")
  }
  const client = new QVACRegistryClient({ registryCoreKey: coreKey })
  try {
    await client.downloadModel(source.path, source.source, { outputFile: destPath, timeout: 5 * 60 * 1000 })
  } finally {
    try { await client.close() } catch (_) {}
  }
}

// Download a blob to test/model/, honouring its source descriptor. Mirrors
// ensureModel()'s cache-by-name behaviour for the custom-fetch (registry) path.
async function ensureBlob (blob) {
  const plan = resolveBlob(blob)
  if (plan.downloadUrl) return ensureModel({ modelName: plan.modelName, downloadUrl: plan.downloadUrl })
  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, plan.modelName)
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 0) return [plan.modelName, modelDir]
  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`[download] Fetching ${plan.modelName} from registry...`)
  await plan.fetch(modelPath)
  return [plan.modelName, modelDir]
}

// Human-readable origin URL for the [VLMMETA] provenance marker.
function displayUrl (blob) {
  const plan = resolveBlob(blob)
  if (plan.downloadUrl) return plan.downloadUrl
  const s = blob.source || {}
  return `registry:${s.source || ''}/${s.path || ''}`
}

// Where the model comes from, for the report's Source column: a `registry`
// annotation wins; otherwise the fetch transport (HF / S3 / URL).
function sourceType (blob) {
  if (blob.registry) return 'Registry'
  const t = (blob.source && blob.source.type) || ''
  return ({ hf: 'HF', s3: 'S3', url: 'URL' })[t] || (t || '—')
}

// Minimal PNG/JPEG dimension reader (no deps, big-endian) for the image table.
function dimsFromBytes (bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return { w: dv.getUint32(16), h: dv.getUint32(20) } // PNG IHDR
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) { // JPEG: find SOF0..3
      let o = 2
      while (o + 9 < bytes.length) {
        if (bytes[o] !== 0xff) { o++; continue }
        const m = bytes[o + 1]
        if (m >= 0xc0 && m <= 0xc3) return { h: dv.getUint16(o + 5), w: dv.getUint16(o + 7) }
        o += 2 + dv.getUint16(o + 2)
      }
    }
  } catch (_) {}
  return { w: null, h: null }
}

function devicesToRun () {
  const raw = env('QVAC_VLM_DEVICES')
  if (raw) return raw.split(',').map(s => s.trim()).filter(Boolean)
  if (PRESET.devices) return PRESET.devices.slice()
  const noGpu = String(env('NO_GPU')).toLowerCase() === 'true'
  return noGpu ? ['cpu'] : ['cpu', 'gpu']
}

async function runOne (inference, imgPath, prompt) {
  const bytes = new Uint8Array(fs.readFileSync(imgPath))
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: bytes },
    { role: 'user', content: prompt }
  ]
  const t0 = Date.now()
  const resp = await inference.run(messages)
  const chunks = []
  let err = null
  resp.onUpdate(d => chunks.push(d)).onError(e => { err = e })
  await resp.await()
  if (err) throw new Error(String(err))
  return { text: chunks.join(''), ms: Date.now() - t0, stats: resp.stats || null, dims: dimsFromBytes(bytes) }
}

function emitRow (obj) {
  console.log('[VLMROW]' + JSON.stringify(obj) + '[/VLMROW]')
}

// Contract-v2 fields stamped into every marker (CONTRACT.md §1). `block` is the
// measurement round: an explicit `block` arg wins (warmup passes stamp 0); else the
// scheduler's QVAC_VLM_BLOCK if set (one block per process); else rep + 1 (measured).
// The report drops block 0 (warmup) from all stats.
function stamp (rep, obj, block) {
  const out = { v: 2, scenario: SCENARIO_ID, source_id: SRC_ID, source_ref: SRC_REF }
  if (block != null) out.block = block
  else if (rep != null) out.block = BLOCK_OVERRIDE != null ? BLOCK_OVERRIDE : rep + 1
  return Object.assign(out, obj)
}

// Peak process memory (MB), cross-platform. bare-os exposes libuv's getrusage as
// resourceUsage().maxRSS, reported in KB on every platform here (Linux, macOS,
// Windows — verified on the Mac mini: a ~2 GB process reads 2,097,152, i.e. KB
// not bytes). Fall back to the Linux /proc high-water for any runtime without
// resourceUsage; null where neither is available.
function peakRssMb () {
  try {
    if (typeof os.resourceUsage === 'function') {
      const max = os.resourceUsage().maxRSS
      if (typeof max === 'number' && max > 0) return Math.round(max / 1024)
    }
  } catch (_) {}
  try {
    const txt = String(fs.readFileSync('/proc/self/status'))
    const m = txt.match(/VmHWM:\s*(\d+)\s*kB/)
    if (m) return Math.round(parseInt(m[1], 10) / 1024)
  } catch (_) {}
  return null
}

function runModel (spec) {
  // Marker axis (the report's comparison column): in several-sources the axis is the
  // SOURCE IDENTITY (source_id) — so build comparisons (addon@candidate vs
  // addon@baseline, same engine) get distinct columns, not just engine comparisons
  // (addon vs fabric-cli vs upstream-cli). In two-models it's the model label.
  const axis = MODE === 'several-sources' ? SRC_ID : spec.label
  if (!ENABLED) {
    test(`vlm-matrix ${spec.label} (disabled; set QVAC_VLM_MATRIX=1)`, t => t.pass('disabled'))
    return
  }
  for (const device of devicesToRun()) {
    const dev = device.toUpperCase()
    test(`vlm-matrix ${spec.label} [${dev}]`, { timeout: TEST_TIMEOUT_MIN * 60 * 1000 }, async t => {
      const [mainName, dir] = await ensureBlob(spec.llm)
      const [projName] = await ensureBlob(spec.mmproj)
      // model-origin provenance (stderr, parsed host-side into the report)
      console.error('[VLMMETA]' + JSON.stringify(stamp(null, {
        cell: axis,
        source: SOURCE,
        model: spec.label,
        main_origin: spec.llm.origin,
        main_url: displayUrl(spec.llm),
        main_source: sourceType(spec.llm),
        mmproj_origin: spec.mmproj.origin,
        mmproj_url: displayUrl(spec.mmproj),
        mmproj_source: sourceType(spec.mmproj)
      })) + '[/VLMMETA]')
      // Size the output cap to the heaviest task in this run (ocr-page needs ~768).
      const items = selectedItems()
      const nPredict = Math.max(DEFAULT_NPREDICT, ...items.map(it => TASK_NPREDICT[it.task] || 0))
      const inference = new LlmLlamacpp({
        files: { model: [path.join(dir, mainName)], projectionModel: path.join(dir, projName) },
        config: {
          device,
          gpu_layers: device === 'cpu' ? '0' : '98',
          temp: '0.0',
          seed: '42',
          ctx_size: spec.ctx_size,
          n_predict: String(nPredict),
          verbosity: '2', // surfaces `image slice encoded in N ms` on native stderr
          'reasoning-budget': '0', // disable Qwen3.5 thinking -> clean direct answers
          ...(BACKENDS_DIR ? { backendsDir: BACKENDS_DIR } : {}) // candidate/baseline build swap (scheduler)
        },
        logger: console,
        opts: { stats: true }
      })
      t.teardown(async () => { try { await inference.unload() } catch (_) {} })
      await inference.load()

      // Warmup (single-process runs only): prime weights/caches and heat the pipeline
      // on the first item, stamped block 0 so the report drops it from stats. The
      // desktop scheduler sets WARMUP_REPEATS=0 (it owns warmup across its own block
      // processes). Warmup rows are emitted so the run stays auditable.
      for (let w = 0; w < WARMUP_REPEATS && items.length; w++) {
        const item = items[0]
        console.error('[VLMSEG]' + JSON.stringify(stamp(null, { cell: axis, source: SOURCE, model: spec.label, device, id: item.id, rep: w }, 0)) + '[/VLMSEG]')
        try {
          const r = await runOne(inference, getMediaPath(item.image), item.prompt)
          const st = r.stats || {}
          emitRow(stamp(null, {
            rss_mb: peakRssMb(),
            cell: axis,
            source: SOURCE,
            model: spec.label,
            device,
            rep: w,
            task: item.task,
            id: item.id,
            metric: item.metric,
            pred: String(r.text).slice(0, predCap(item.task)),
            img: item.image,
            img_w: r.dims.w,
            img_h: r.dims.h,
            ms: r.ms,
            decode_tps: st.TPS != null ? st.TPS : null,
            ttft_ms: st.TTFT != null ? st.TTFT : null,
            gen_tokens: st.generatedTokens != null ? st.generatedTokens : null,
            prompt_tokens: st.promptTokens != null ? st.promptTokens : null
          }, 0))
        } catch (e) {
          emitRow(stamp(null, { rss_mb: peakRssMb(), cell: axis, source: SOURCE, model: spec.label, device, rep: w, task: item.task, id: item.id, metric: item.metric, error: String((e && e.message) || e) }, 0))
        }
      }
      // After warming, wait for the machine to settle before the measured pass so
      // throttling state doesn't bias it. Bounded tight on mobile to stay under the
      // Device Farm per-test ceiling; emits a [VLMBLOCK] marker recording the wait.
      //
      // Desktop runs the guard OFF: thermal settle matters for the phone, but the fresh
      // CI desktop VMs have no throttling to wait out, and the probe doesn't reliably
      // stabilise on a contended runner. Warmup + median-over-repeats cover desktop noise.
      if (WARMUP_REPEATS > 0) {
        const guardOpts = isMobile ? { mode: 'probe', maxWaitMs: 6000, intervalMs: 800, window: 3 } : { mode: 'off' }
        const stability = await stabilityGuard(guardOpts)
        // console.log (not process.stdout) — `bare` (desktop + mobile runtime) has no
        // `process` global; markers go to stdout the same way emitRow does.
        console.log('[VLMBLOCK]' + JSON.stringify({ v: 2, scenario: SCENARIO_ID, source_id: SRC_ID, source_ref: SRC_REF, model: spec.label, device, block: 1, stability }) + '[/VLMBLOCK]')
      }

      let ok = 0
      for (const item of items) {
        for (let rep = 0; rep < REPEATS; rep++) {
          // SEG per repeat so each run's `image slice encoded` lines attribute to its
          // own segment (stderr — same stream as the native timing lines).
          console.error('[VLMSEG]' + JSON.stringify(stamp(rep, { cell: axis, source: SOURCE, model: spec.label, device, id: item.id, rep })) + '[/VLMSEG]')
          try {
            const r = await runOne(inference, getMediaPath(item.image), item.prompt)
            const st = r.stats || {}
            emitRow(stamp(rep, {
              rss_mb: peakRssMb(),
              cell: axis,
              source: SOURCE,
              model: spec.label,
              device,
              rep,
              task: item.task,
              id: item.id,
              metric: item.metric,
              pred: String(r.text).slice(0, predCap(item.task)),
              img: item.image,
              img_w: r.dims.w,
              img_h: r.dims.h,
              ms: r.ms,
              decode_tps: st.TPS != null ? st.TPS : null,
              ttft_ms: st.TTFT != null ? st.TTFT : null,
              gen_tokens: st.generatedTokens != null ? st.generatedTokens : null,
              prompt_tokens: st.promptTokens != null ? st.promptTokens : null
            }))
            ok++
          } catch (e) {
            emitRow(stamp(rep, { rss_mb: peakRssMb(), cell: axis, source: SOURCE, model: spec.label, device, rep, task: item.task, id: item.id, metric: item.metric, error: String((e && e.message) || e) }))
          }
        }
      }
      t.ok(ok > 0, `${spec.label} [${dev}] produced ${ok}/${items.length} predictions`)
    })
  }
}

// One test file -> one mobile test function -> one Device Farm spec -> one phone.
// two-models runs the QVAC_VLM_MODELS launch param (catalog names, ad-hoc
// <llm-url>|<mmproj-url> pairs, or json: specs — see models.cjs / CONTRACT.md §3),
// falling back to the committed config.models pair; several-sources loads the one
// sourcesModel (the other engines run via cli-fixture-runner.cjs, same log).
function runAll () {
  const models = MODE === 'several-sources'
    ? [config.sourcesModel]
    : parseModels(env('QVAC_VLM_MODELS'), config.catalog, config.models)
  // When the desktop scheduler drives one (source × model × block) per process it pins
  // the model by index (QVAC_VLM_MODEL_INDEX); otherwise run the whole list.
  const selected = MODEL_INDEX != null && models[MODEL_INDEX] ? [models[MODEL_INDEX]] : models
  for (const spec of selected) runModel(spec)
}

module.exports = { runModel, runAll }
