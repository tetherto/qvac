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
// samples/task: mobile defaults low to fit the 30-min Device Farm ceiling; override via
// QVAC_VLM_SAMPLES, or on mobile via the qvac_perf_runs dispatch input (pushed as QVAC_PERF_RUNS).
const SAMPLES_PER_TASK = intEnv('QVAC_VLM_SAMPLES') || intEnv('QVAC_PERF_RUNS') || (isMobile ? 2 : 5)
function selectedItems () {
  const seen = {}
  return fixture.items.filter(it => {
    seen[it.task] = (seen[it.task] || 0) + 1
    return seen[it.task] <= SAMPLES_PER_TASK
  })
}

// FINAL registry-compatibility test: the MAIN model + the f16 mmproj are the EXACT files
// already in the QVAC registry ("as-is"); the q8 slot is the Q8 mmproj CANDIDATE we want
// to add. So q8-vs-f16 here = candidate-vs-registry on the registry's own main. All HF
// URLs pinned to the registry's / candidate's commit SHAs (immutable provenance).
const SHA = {
  qwenUnsloth: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0', // registry main + f16 mmproj
  qwenMrader: '9d48fdbc0d8f133716da87ec1d904e5d2c7175a6',  // candidate q8 mmproj
  gemmaBart: 'b5e99bd964eaacc27ba484bb2eb3e9f6160b9143',   // registry main + f16 mmproj
  gemmaGgml: 'a1dac71d3ab220618f5a7573a52acdc4baf3ae3b'    // candidate q8 mmproj
}
const HF = (repo, sha, file) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`
const MODELS = {
  qwen: {
    main: { modelName: 'reg-qwen-unsloth-Q8_0.gguf', origin: `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)} (registry main)`,
            downloadUrl: HF('unsloth/Qwen3.5-0.8B-GGUF', SHA.qwenUnsloth, 'Qwen3.5-0.8B-Q8_0.gguf') },
    mmproj: {
      f16: { modelName: 'reg-qwen-unsloth-mmproj-F16.gguf', origin: `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)} (registry f16)`,
             downloadUrl: HF('unsloth/Qwen3.5-0.8B-GGUF', SHA.qwenUnsloth, 'mmproj-F16.gguf') },
      q8: { modelName: 'cand-qwen-mradermacher-mmproj-Q8_0.gguf', origin: `mradermacher/Qwen3.5-0.8B-GGUF@${SHA.qwenMrader.slice(0, 10)} (CANDIDATE q8)`,
            downloadUrl: HF('mradermacher/Qwen3.5-0.8B-GGUF', SHA.qwenMrader, 'Qwen3.5-0.8B.mmproj-Q8_0.gguf') }
    },
    ctx_size: '4096'
  },
  gemma: {
    main: { modelName: 'reg-gemma-bartowski-Q4_K_M.gguf', origin: `bartowski/google_gemma-4-E2B-it-GGUF@${SHA.gemmaBart.slice(0, 10)} (registry main)`,
            downloadUrl: HF('bartowski/google_gemma-4-E2B-it-GGUF', SHA.gemmaBart, 'google_gemma-4-E2B-it-Q4_K_M.gguf') },
    mmproj: {
      f16: { modelName: 'reg-gemma-bartowski-mmproj-f16.gguf', origin: `bartowski/google_gemma-4-E2B-it-GGUF@${SHA.gemmaBart.slice(0, 10)} (registry f16)`,
             downloadUrl: HF('bartowski/google_gemma-4-E2B-it-GGUF', SHA.gemmaBart, 'mmproj-google_gemma-4-E2B-it-f16.gguf') },
      q8: { modelName: 'cand-gemma-ggml-mmproj-Q8_0.gguf', origin: `ggml-org/gemma-4-E2B-it-GGUF@${SHA.gemmaGgml.slice(0, 10)} (CANDIDATE q8)`,
            downloadUrl: HF('ggml-org/gemma-4-E2B-it-GGUF', SHA.gemmaGgml, 'mmproj-gemma-4-E2B-it-Q8_0.gguf') }
    },
    ctx_size: '4096'
  }
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
      const [mainName, dir] = await ensureModel(cfg.main)
      const [projName] = await ensureModel(cfg.mmproj[mmprojKey])
      // model-origin provenance (stderr, parsed host-side into the report)
      console.error('[VLMMETA]' + JSON.stringify({
        cell, model: modelKey, mmproj: mmprojKey,
        main_origin: cfg.main.origin, main_url: cfg.main.downloadUrl,
        mmproj_origin: cfg.mmproj[mmprojKey].origin, mmproj_url: cfg.mmproj[mmprojKey].downloadUrl
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

// Loops the whole matrix (2 models x 2 mmproj) in one test file -> one mobile test
// function -> one Device Farm spec -> single-spec dual-flagship -> Samsung S25.
function runAllCells () {
  for (const [model, mmproj] of [['qwen', 'q8'], ['qwen', 'f16'], ['gemma', 'q8'], ['gemma', 'f16']]) {
    runVlmCell(model, mmproj)
  }
}

module.exports = { runVlmCell, runAllCells, MODELS }
