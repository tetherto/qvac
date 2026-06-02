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
const ENABLED = env('QVAC_VLM_MATRIX') === '1'

const HF_QWEN = 'https://huggingface.co/mradermacher/Qwen3.5-0.8B-GGUF/resolve/main'
const HF_GEMMA = 'https://huggingface.co/mradermacher/gemma-4-E2B-it-ultra-uncensored-heretic-GGUF/resolve/main'

const MODELS = {
  qwen: {
    main: { modelName: 'vlmx-qwen3.5-0.8b-Q8_0.gguf', downloadUrl: HF_QWEN + '/Qwen3.5-0.8B.Q8_0.gguf' },
    mmproj: {
      q8: { modelName: 'vlmx-qwen-mmproj-Q8_0.gguf', downloadUrl: HF_QWEN + '/Qwen3.5-0.8B.mmproj-Q8_0.gguf' },
      f16: { modelName: 'vlmx-qwen-mmproj-f16.gguf', downloadUrl: HF_QWEN + '/Qwen3.5-0.8B.mmproj-f16.gguf' }
    },
    ctx_size: '4096'
  },
  gemma: {
    main: { modelName: 'vlmx-gemma-4-e2b-IQ4_XS.gguf', downloadUrl: HF_GEMMA + '/gemma-4-E2B-it-ultra-uncensored-heretic.IQ4_XS.gguf' },
    mmproj: {
      q8: { modelName: 'vlmx-gemma-mmproj-Q8_0.gguf', downloadUrl: HF_GEMMA + '/gemma-4-E2B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf' },
      f16: { modelName: 'vlmx-gemma-mmproj-f16.gguf', downloadUrl: HF_GEMMA + '/gemma-4-E2B-it-ultra-uncensored-heretic.mmproj-f16.gguf' }
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
      const tap = createLogTap()
      const inference = new LlmLlamacpp({
        files: { model: [path.join(dir, mainName)], projectionModel: path.join(dir, projName) },
        config: {
          device,
          gpu_layers: device === 'cpu' ? '0' : '98',
          temp: '0.0',
          seed: '42',
          ctx_size: cfg.ctx_size,
          n_predict: '128',
          verbosity: '2', // surfaces `image slice encoded in N ms` via the logger
          'reasoning-budget': '0' // disable Qwen3.5 thinking -> clean direct answers
        },
        logger: tap.logger,
        opts: { stats: true }
      })
      t.teardown(async () => { try { await inference.unload() } catch (_) {} })
      await inference.load()

      let ok = 0
      for (const item of fixture.items) {
        tap.clear()
        try {
          const r = await runOne(inference, getMediaPath(item.image), item.prompt)
          const m = parseAddonLog(tap.text())
          const st = r.stats || {}
          // vision-encode is parsed from native stderr host-side (aggregate.js); decode
          // TPS/TTFT come from response.stats (the addon doesn't print eval-time lines).
          emitRow({
            cell, model: modelKey, mmproj: mmprojKey, device,
            task: item.task, id: item.id, metric: item.metric, gold: item.gold,
            pred: String(r.text).slice(0, 600),
            ms: r.ms,
            vision_encode_ms: m.visionEncodeMs != null ? m.visionEncodeMs : null,
            vision_slices: m.visionSlices != null ? m.visionSlices : null,
            decode_tps: m.decodeTps != null ? m.decodeTps : (st.TPS != null ? st.TPS : null),
            ttft_ms: st.TTFT != null ? st.TTFT : null,
            gen_tokens: st.generatedTokens != null ? st.generatedTokens : null,
            prompt_tokens: st.promptTokens != null ? st.promptTokens : null
          })
          ok++
        } catch (e) {
          emitRow({ cell, model: modelKey, mmproj: mmprojKey, device, task: item.task, id: item.id, metric: item.metric, gold: item.gold, error: String((e && e.message) || e) })
        }
      }
      t.ok(ok > 0, `${cell} [${dev}] produced ${ok}/${fixture.items.length} predictions`)
    })
  }
}

module.exports = { runVlmCell, MODELS }
