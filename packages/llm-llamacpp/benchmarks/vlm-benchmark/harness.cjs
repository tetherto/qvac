'use strict'
// QVAC-19178: VLM benchmark harness. Loops the fixture (fixture.data.cjs) for one
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

// Resolve a fixture image. Images live in a fixture object store (not git): CI syncs
// them into this dir's images/ before the run. Desktop reads images/ directly; mobile
// uses the bundled asset manifest (stage.cjs copies images/ -> test/mobile/testAssets
// after that sync).
function getMediaPath (filename) {
  if ((os.platform() === 'ios' || os.platform() === 'android') && global.assetPaths) {
    const key = `../../testAssets/${filename}`
    if (global.assetPaths[key]) return global.assetPaths[key].replace('file://', '')
    throw new Error(`Asset not found in testAssets: ${filename} (rebuild the app)`)
  }
  return path.join(__dirname, 'images', filename)
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

// Active preset = the run SIZE (tasks × samples × repeats), independent of mode.
// QVAC_VLM_PRESET overrides config.defaultPreset on desktop; on mobile there is no env
// passthrough, so config.defaultPreset is the only knob. Unknown name => all-defaults.
const PRESET = config.presets[env('QVAC_VLM_PRESET') || config.defaultPreset] ||
  { tasks: null, samplesPerTask: null, devices: null }

// Comparison mode + this run's engine. In 'several-sources' the comparison axis is
// the engine (this addon leg is one of addon/fabric-cli/upstream-cli), so markers are
// keyed by the source label instead of the model label. Driven by env on desktop.
const MODE = env('QVAC_VLM_MODE') || config.mode || 'two-models'
const SOURCE = env('QVAC_VLM_ENGINE') || config.engine || 'addon'

// samples/task precedence: explicit env > preset > (mobile 2 / desktop 5). Mobile
// defaults low to fit the 30-min Device Farm ceiling; qvac_perf_runs lands here.
const SAMPLES_PER_TASK = intEnv('QVAC_VLM_SAMPLES') || intEnv('QVAC_PERF_RUNS') ||
  PRESET.samplesPerTask || (isMobile ? 2 : 5)

// Repeats per (sample): each inference is run N times so the report's timings are a
// mean over repeats and any nondeterminism is visible. Default 3 on desktop; 1 on
// mobile to stay under the Device Farm ceiling. Override with QVAC_VLM_REPEATS.
const REPEATS = intEnv('QVAC_VLM_REPEATS') || PRESET.repeats || (isMobile ? 1 : 3)

// tasks: QVAC_VLM_TASKS (csv) > preset.tasks > all fixture tasks (null = no filter).
const TASKS = (() => {
  const raw = env('QVAC_VLM_TASKS')
  if (raw) return raw.split(',').map(s => s.trim()).filter(Boolean)
  return PRESET.tasks || null
})()

function selectedItems () {
  const seen = {}
  return fixture.items.filter(it => {
    if (TASKS && !TASKS.includes(it.task)) return false
    seen[it.task] = (seen[it.task] || 0) + 1
    return seen[it.task] <= SAMPLES_PER_TASK
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

function runModel (spec) {
  // Marker axis: source label in several-sources mode (engine comparison), else the
  // model label. The VLM loaded is always spec (llm + mmproj).
  const axis = MODE === 'several-sources' ? SOURCE : spec.label
  if (!ENABLED) {
    test(`vlm-matrix ${spec.label} (disabled; set QVAC_VLM_MATRIX=1)`, t => t.pass('disabled'))
    return
  }
  for (const device of devicesToRun()) {
    const dev = device.toUpperCase()
    test(`vlm-matrix ${spec.label} [${dev}]`, { timeout: 30 * 60 * 1000 }, async t => {
      const [mainName, dir] = await ensureBlob(spec.llm)
      const [projName] = await ensureBlob(spec.mmproj)
      // model-origin provenance (stderr, parsed host-side into the report)
      console.error('[VLMMETA]' + JSON.stringify({
        cell: axis,
        source: SOURCE,
        model: spec.label,
        main_origin: spec.llm.origin,
        main_url: displayUrl(spec.llm),
        main_source: sourceType(spec.llm),
        mmproj_origin: spec.mmproj.origin,
        mmproj_url: displayUrl(spec.mmproj),
        mmproj_source: sourceType(spec.mmproj)
      }) + '[/VLMMETA]')
      const inference = new LlmLlamacpp({
        files: { model: [path.join(dir, mainName)], projectionModel: path.join(dir, projName) },
        config: {
          device,
          gpu_layers: device === 'cpu' ? '0' : '98',
          temp: '0.0',
          seed: '42',
          ctx_size: spec.ctx_size,
          n_predict: '128',
          verbosity: '2', // surfaces `image slice encoded in N ms` on native stderr
          'reasoning-budget': '0' // disable Qwen3.5 thinking -> clean direct answers
        },
        logger: console,
        opts: { stats: true }
      })
      t.teardown(async () => { try { await inference.unload() } catch (_) {} })
      await inference.load()

      const items = selectedItems()
      let ok = 0
      for (const item of items) {
        for (let rep = 0; rep < REPEATS; rep++) {
          // SEG per repeat so each run's `image slice encoded` lines attribute to its
          // own segment (stderr — same stream as the native timing lines).
          console.error('[VLMSEG]' + JSON.stringify({ cell: axis, source: SOURCE, model: spec.label, device, id: item.id, rep }) + '[/VLMSEG]')
          try {
            const r = await runOne(inference, getMediaPath(item.image), item.prompt)
            const st = r.stats || {}
            emitRow({
              cell: axis,
              source: SOURCE,
              model: spec.label,
              device,
              rep,
              task: item.task,
              id: item.id,
              metric: item.metric,
              gold: item.gold,
              pred: String(r.text).slice(0, 600),
              img: item.image,
              img_w: r.dims.w,
              img_h: r.dims.h,
              ms: r.ms,
              decode_tps: st.TPS != null ? st.TPS : null,
              ttft_ms: st.TTFT != null ? st.TTFT : null,
              gen_tokens: st.generatedTokens != null ? st.generatedTokens : null,
              prompt_tokens: st.promptTokens != null ? st.promptTokens : null
            })
            ok++
          } catch (e) {
            emitRow({ cell: axis, source: SOURCE, model: spec.label, device, rep, task: item.task, id: item.id, metric: item.metric, gold: item.gold, error: String((e && e.message) || e) })
          }
        }
      }
      t.ok(ok > 0, `${spec.label} [${dev}] produced ${ok}/${items.length} predictions`)
    })
  }
}

// One test file -> one mobile test function -> one Device Farm spec -> Samsung S25.
// two-models loads MODEL_1 then MODEL_2; several-sources loads the one sourcesModel
// (the other engines run via cli-fixture-runner.cjs and append to the same log).
function runAll () {
  const models = MODE === 'several-sources' ? [config.sourcesModel] : config.models
  for (const spec of models) runModel(spec)
}

module.exports = { runModel, runAll }
