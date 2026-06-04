'use strict'
// QVAC-19178: unified VLM benchmark harness. Loops the frozen 5x5 fixture
// (vlm-fixture.data.cjs) over {cpu,gpu} for ONE (model x mmproj) cell and emits one
// [VLMROW]{json}[/VLMROW] marker per sample. The SAME code runs on the desktop
// integration path (Linux) and the mobile Device Farm path (S25); host-side
// aggregate.js parses the markers into quality + speed matrices.
//
// HEADLINE METRIC: mmproj/vision-encode time (visionEncodeMs). This is the part the
// Q8-vs-f16 projector choice actually drives. The addon emits `image slice encoded in
// N ms` lines through the JS logger at verbosity=2 (NOT via response.stats); we capture
// them with a log tap and sum across tiles — identical to benchmarks/vlm-performance.
//
// Gated by QVAC_VLM_MATRIX=1 so the 6 GB of model downloads never fire during the
// normal integration suite — only the dedicated benchmark-vlm-matrix workflow sets it.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { ensureModel, getMediaPath } = require('./utils')
const LlmLlamacpp = require('../../index.js')
const fixture = require('./vlm-fixture.data.cjs')
const config = require('./vlm-matrix.config.cjs')

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

// Active preset selects which cells/tasks/samples/devices run. QVAC_VLM_PRESET
// overrides config.defaultPreset on Linux; on S25 there is no env passthrough, so
// config.defaultPreset is the only knob. Unknown name => an all-defaults preset.
const PRESET = config.presets[env('QVAC_VLM_PRESET') || config.defaultPreset] ||
  { cells: null, tasks: null, samplesPerTask: null, devices: null }

// samples/task precedence: explicit env > preset > (mobile 2 / desktop 5). Mobile
// defaults low to fit the 30-min Device Farm ceiling; qvac_perf_runs lands here.
const SAMPLES_PER_TASK = intEnv('QVAC_VLM_SAMPLES') || intEnv('QVAC_PERF_RUNS') ||
  PRESET.samplesPerTask || (isMobile ? 2 : 5)

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

// Cells, models and their per-blob source descriptors live in vlm-matrix.config.cjs
// (the registry-compatibility story — f16 = registry mmproj, q8 = candidate — is
// documented there). The harness only resolves descriptors to concrete files.
const MODELS = config.models

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

// Same patterns benchmarks/vlm-performance/stdout-parser.js uses. Vision-encode is
// SUMMED across `image slice encoded` lines (dynamic-res VLMs emit one per tile).
const VISION_RE = /image (?:slice )?encoded in\s+(\d+(?:\.\d+)?)\s*ms/gi
const PROMPT_RE = /prompt eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+tokens\s*\([^)]*?(\d+(?:\.\d+)?)\s+tokens per second\)/i
const EVAL_RE = /(?<!prompt )eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+(?:tokens|runs)\s*\([^)]*?(\d+(?:\.\d+)?)\s+tokens per second\)/i

function parseAddonLog (text) {
  const out = {}
  const vis = [...String(text).matchAll(VISION_RE)]
  if (vis.length) {
    out.visionEncodeMs = vis.reduce((s, m) => s + Number(m[1]), 0)
    out.visionSlices = vis.length
  }
  const p = String(text).match(PROMPT_RE)
  if (p) { out.promptEvalMs = Number(p[1]); out.promptTokens = Number(p[2]); out.promptTps = Number(p[3]) }
  const e = String(text).match(EVAL_RE)
  if (e) { out.decodeMs = Number(e[1]); out.decodeTokens = Number(e[2]); out.decodeTps = Number(e[3]) }
  return out
}

function createLogTap () {
  const lines = []
  const push = (...a) => { lines.push(a.map(String).join(' ')) }
  const logger = { error: push, warn: push, info: push, debug: push, log: push }
  return { logger, text: () => lines.join('\n'), clear: () => { lines.length = 0 } }
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
  return { text: chunks.join(''), ms: Date.now() - t0, stats: resp.stats || null }
}

function emitRow (obj) {
  console.log('[VLMROW]' + JSON.stringify(obj) + '[/VLMROW]')
}

function runVlmCell (modelKey, mmprojKey) {
  const cell = `${modelKey}-${mmprojKey}`
  if (!ENABLED) {
    test(`vlm-matrix ${cell} (disabled; set QVAC_VLM_MATRIX=1)`, t => t.pass('disabled'))
    return
  }
  const cfg = MODELS[modelKey]
  for (const device of devicesToRun()) {
    const dev = device.toUpperCase()
    test(`vlm-matrix ${cell} [${dev}]`, { timeout: 30 * 60 * 1000 }, async t => {
      const [mainName, dir] = await ensureBlob(cfg.main)
      const [projName] = await ensureBlob(cfg.mmproj[mmprojKey])
      // model-origin provenance (stderr, parsed host-side into the report)
      console.error('[VLMMETA]' + JSON.stringify({
        cell, model: modelKey, mmproj: mmprojKey,
        main_origin: cfg.main.origin, main_url: displayUrl(cfg.main),
        mmproj_origin: cfg.mmproj[mmprojKey].origin, mmproj_url: displayUrl(cfg.mmproj[mmprojKey])
      }) + '[/VLMMETA]')
      const inference = new LlmLlamacpp({
        files: { model: [path.join(dir, mainName)], projectionModel: path.join(dir, projName) },
        config: {
          device,
          gpu_layers: device === 'cpu' ? '0' : '98',
          temp: '0.0',
          seed: '42',
          ctx_size: cfg.ctx_size,
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
        // segment marker on STDERR — same stream as llama.cpp's `image slice encoded`
        // lines, so host-side attribution is alignment-proof (stdout [VLMROW] markers
        // can interleave unpredictably after 2>&1).
        console.error('[VLMSEG]' + JSON.stringify({ cell, model: modelKey, mmproj: mmprojKey, device, id: item.id }) + '[/VLMSEG]')
        try {
          const r = await runOne(inference, getMediaPath(item.image), item.prompt)
          const st = r.stats || {}
          emitRow({
            cell, model: modelKey, mmproj: mmprojKey, device,
            task: item.task, id: item.id, metric: item.metric, gold: item.gold,
            pred: String(r.text).slice(0, 600),
            ms: r.ms,
            decode_tps: st.TPS != null ? st.TPS : null,
            ttft_ms: st.TTFT != null ? st.TTFT : null,
            gen_tokens: st.generatedTokens != null ? st.generatedTokens : null,
            prompt_tokens: st.promptTokens != null ? st.promptTokens : null
          })
          ok++
        } catch (e) {
          emitRow({ cell, model: modelKey, mmproj: mmprojKey, device, task: item.task, id: item.id, metric: item.metric, gold: item.gold, error: String((e && e.message) || e) })
        }
      }
      t.ok(ok > 0, `${cell} [${dev}] produced ${ok}/${items.length} predictions`)
    })
  }
}

// Loops the active preset's cells (model · mmproj) in one test file -> one mobile
// test function -> one Device Farm spec -> single-spec dual-flagship -> Samsung S25.
function runAllCells () {
  const cells = PRESET.cells || config.allCells
  for (const c of cells) runVlmCell(c.model, c.mmproj)
}

module.exports = { runVlmCell, runAllCells, MODELS }
