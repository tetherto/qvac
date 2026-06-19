'use strict'

// Shared runner for the mobile perf benchmark. Sharded into one test file per
// (model x KV-cache type) (benchmark-perf-<size>-<quant>-<cachetype>.test.js)
// so each Device Farm session finishes inside the fixed 20-minute iOS per-test
// ceiling; this module holds the logic they all share. Underscore prefix keeps
// it out of the mobile test generator (it is not a *.test.js file).
//
// Each shard sweeps its model across both devices (gpu, cpu) and both
// reasoning-budget values (-1, 0), recording TTFT / TPS / ppTPS. The full
// matrix (2 sizes x 5 quants x 7 KV-cache types x 2 devices x 2 budgets) is
// split across the shard files; nothing here reduces it.

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const { recordPerformance, isMobile } = require('./_perf-helper.js')
const { modelId } = require('./_benchmark-matrix.js')
const os = require('bare-os')

const DEVICES = ['gpu', 'cpu']
const REASONING_BUDGETS = ['-1', '0']

const RUNTIME = {
  gpu_layers: '999',
  ctx_size: '2048',
  n_predict: '512',
  temp: '0.1',
  seed: '42',
  verbosity: '0'
}

// ~512-token prompt (verified against the Qwen3.5 tokenizer at 518 templated tokens).
const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  {
    role: 'user',
    content: 'Summarize the following passage and explain its key technical implications for on-device inference.\n\nModern large language models have transformed natural language processing. Unlike earlier systems that relied on handcrafted features and task-specific architectures, transformer-based models learn general-purpose representations that transfer across many tasks. This shift enabled strong performance in text generation, translation, question answering, and code synthesis, frequently matching expert humans on established benchmarks.\n\nThe scaling laws governing these models describe a consistent relationship between compute, training data, and model capacity. As researchers grow model size and dataset volume, capabilities tend to improve smoothly and predictably, with occasional emergent abilities appearing at particular scale thresholds. This predictability has guided the design of increasingly capable systems, while raising real questions about energy use and cost.\n\nInference efficiency is now a central challenge. Quantization reduces the memory footprint and increases throughput by storing weights at lower numerical precision, allowing deployment on edge devices that would otherwise lack the necessary memory bandwidth. Speculative decoding and continuous batching push throughput further by using available compute more fully during autoregressive generation. Together these techniques make it practical to run capable models locally on consumer hardware, cutting latency and preserving privacy because data never leaves the device.\n\nReasoning quality continues to improve through chain-of-thought prompting and reinforcement learning from human feedback. Models with an explicit reasoning budget can spend more computation on hard problems while staying efficient on simple queries by disabling the reasoning trace entirely. Balancing this budget against latency and battery on mobile hardware is an open and practical engineering problem that the field is only beginning to address in production systems.\n\nOn mobile devices the constraints are sharper than on servers. Memory is limited, thermal headroom is small, and sustained throughput drops as the device heats up under a long generation. Prefill throughput, measured as prompt tokens processed per second, often behaves very differently from decode throughput, because prefill is compute bound across the whole prompt while decode is memory bound on a single token at a time. Quantization format interacts with both phases in ways that are hard to predict from first principles, which is exactly why empirical benchmarks across formats and devices matter. A format that is fast to decode on a desktop GPU may be slower on a phone because of how its blocks map onto the available kernels and cache hierarchy. Measuring time to first token, decode tokens per second, and prefill tokens per second across each quantization and reasoning setting gives the clearest practical picture of what users will actually experience.'
  }
]

function _envInt (key, fallback) {
  let raw = ''
  if (typeof os.getEnv === 'function') raw = os.getEnv(key) || ''
  if (!raw && typeof process !== 'undefined' && process.env) raw = process.env[key] || ''
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
// 3 measured repetitions per config so the renderer can report mean + stddev
// (matches the desktop sweep, which repeats 5x). Overridable via QVAC_PERF_RUNS.
const PERF_RUNS = _envInt('QVAC_PERF_RUNS', 3)
const PERF_WARMUP_RUNS = _envInt('QVAC_PERF_WARMUP_RUNS', 1)

function modelSpec (size, quant) {
  return {
    id: modelId(size, quant),
    name: `Qwen3.5-${size}-${quant}.gguf`,
    url: `https://huggingface.co/unsloth/Qwen3.5-${size}-GGUF/resolve/main/Qwen3.5-${size}-${quant}.gguf`
  }
}

async function runInference (addon, prompt, reasoningBudget) {
  const startTime = Date.now()
  const response = await addon.run(prompt, {
    generationParams: { reasoning_budget: parseInt(reasoningBudget, 10) }
  })
  const chunks = []
  let error = null
  response
    .onUpdate(data => { chunks.push(data) })
    .onError(err => { error = err })
  await response.await()
  if (error) throw new Error('inference failed: ' + error)
  return { output: chunks.join('').trim(), startTime, endTime: Date.now(), stats: response.stats || null }
}

// Records a placeholder row with no metrics. The renderer shows any row
// without TTFT/TPS/ppTPS as `Crashed`. We emit one up-front for every combo
// BEFORE loading/running it, so a hard native crash that kills the Device
// Farm session still leaves a `Crashed` row in the logs (the mobile reporter
// flushes each record to console immediately). A successful run records the
// real metrics afterwards, which supersedes the placeholder in the renderer.
function recordCrashedPlaceholder (label, device, model) {
  recordPerformance(label, 0, { stats: null, deviceId: device, scenario: 'benchmark-perf', model })
}

// Registers the benchmark test for one (model x quant x kv-cache type),
// sweeping device x reasoning-budget. One Device Farm session per call.
// kv-cache type is set as cache-type-k/v at load time. Adreno devices don't
// support quantized KV cache, and TurboQuant/PolarQuant (tbq*/pq*) ship Vulkan
// + CPU kernels only (rejected on Metal/iOS, unsupported on some GPUs), so
// those combos may crash or fail to load — reported as Crashed.
function benchmarkModel (size, quant, cacheK, cacheV) {
  const spec = modelSpec(size, quant)
  // kvLabel uses the k/v form when key and value differ (e.g. TurboQuant
  // tbq3_0/pq3_0), matching the renderer's [kv=...] tag. kvId is the
  // slash-free token used for the model id and per-run identifiers.
  const kvLabel = cacheK === cacheV ? cacheK : `${cacheK}/${cacheV}`
  const kvId = cacheK === cacheV ? cacheK : `${cacheK}-${cacheV}`
  const id = `${spec.id}-${kvId}`
  safeTest(`Mobile perf benchmark: ${id} (TTFT / TPS / ppTPS)`, {
    timeout: 1_800_000,
    skip: !isMobile
  }, async t => {
    const specLogger = attachSpecLogger({ forwardToConsole: true })
    try {
      const [modelName, dirPath] = await ensureModel({ modelName: spec.name, downloadUrl: spec.url })
      const modelPath = path.join(dirPath, modelName)

      // Up-front Crashed placeholders for EVERY combo across BOTH devices before
      // any load/run, so a hard native crash during the first device's pass still
      // leaves rows for the other device. Real metrics supersede these.
      for (const device of DEVICES) {
        for (const rb of REASONING_BUDGETS) {
          recordCrashedPlaceholder(`[${spec.id}] [${device}] [rb=${rb}] [kv=${kvLabel}]`, device, `${id}-${device}-rb${rb}`)
        }
      }

      for (const device of DEVICES) {
        const labelFor = rb => `[${spec.id}] [${device}] [rb=${rb}] [kv=${kvLabel}]`
        const modelFor = rb => `${id}-${device}-rb${rb}`

        let addon = null
        try {
          addon = new LlmLlamacpp({
            files: { model: [modelPath] },
            config: { ...RUNTIME, device, 'cache-type-k': cacheK, 'cache-type-v': cacheV },
            logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
            opts: { stats: true }
          })
          await addon.load()
        } catch (loadErr) {
          // Load failed (e.g. unsupported quantized KV cache) — placeholders
          // remain Crashed for this device's combos. Move on.
          t.comment(`[${id}] [${device}] load failed (reported as Crashed): ${loadErr && loadErr.message ? loadErr.message : loadErr}`)
          await (addon && addon.unload && addon.unload().catch(() => {}))
          continue
        }

        try {
          // Warm up once per backend, not per reasoning budget. The warm-up
          // primes the GPU kernels/caches for this loaded model; reasoning
          // budget is a per-call generation param that does not change the
          // compute kernels, so one warm-up covers both budgets. It is
          // discarded, never a measured rep, so the 3 reps and their stddev
          // are unaffected.
          try {
            for (let w = 1; w <= PERF_WARMUP_RUNS; w++) {
              const { endTime, startTime } = await runInference(addon, PROMPT, REASONING_BUDGETS[0])
              t.comment(`[${id}] [${device}] warmup ${w}/${PERF_WARMUP_RUNS} (${endTime - startTime}ms) - perf NOT recorded`)
            }
          } catch (warmErr) {
            t.comment(`[${id}] [${device}] warmup failed: ${warmErr && warmErr.message ? warmErr.message : warmErr}`)
          }
          for (const rb of REASONING_BUDGETS) {
            const label = labelFor(rb)
            try {
              for (let run = 1; run <= PERF_RUNS; run++) {
                const { output, startTime, endTime, stats } = await runInference(addon, PROMPT, rb)
                // Real metrics supersede the Crashed placeholder in the renderer.
                t.comment(recordPerformance(label, endTime - startTime, {
                  stats,
                  deviceId: device,
                  scenario: 'benchmark-perf',
                  model: modelFor(rb)
                }))
                t.ok(output.length > 0, `${label} run ${run}/${PERF_RUNS} produced output`)
              }
            } catch (runErr) {
              // Catchable run failure — placeholder stays Crashed for this combo.
              t.comment(`${label} run failed (reported as Crashed): ${runErr && runErr.message ? runErr.message : runErr}`)
            }
          }
        } finally {
          await addon.unload().catch(() => {})
        }
      }
    } finally {
      specLogger.release()
    }
  })
}

module.exports = { benchmarkModel, modelSpec }
