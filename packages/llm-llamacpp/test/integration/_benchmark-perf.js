'use strict'

// Shared runner for the mobile perf benchmark. Sharded into one test file per
// (model x KV-cache type) (benchmark-perf-<size>-<quant>-<cachetype>.test.js)
// so each Device Farm session finishes inside the fixed 20-minute iOS per-test
// ceiling; this module holds the logic they all share. Underscore prefix keeps
// it out of the mobile test generator (it is not a *.test.js file).
//
// Each shard sweeps its model across both devices (gpu, cpu) and both
// reasoning-budget values (-1, 0), recording TTFT / TPS / ppTPS. The full
// matrix (2 sizes x 5 quants x 7 KV-cache types x 2 devices x 2 budgets), plus
// the additive batch group (2 sizes x 2 batch sizes at a fixed Q4_0 / f16
// baseline), is split across the shard files; nothing here reduces it.

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const { recordPerformance, isMobile } = require('./_perf-helper.js')
const { modelId, modelFileName } = require('./_benchmark-matrix.js')
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
    content:
      'Summarize the following passage and explain its key technical implications for on-device inference.\n\nModern large language models have transformed natural language processing. Unlike earlier systems that relied on handcrafted features and task-specific architectures, transformer-based models learn general-purpose representations that transfer across many tasks. This shift enabled strong performance in text generation, translation, question answering, and code synthesis, frequently matching expert humans on established benchmarks.\n\nThe scaling laws governing these models describe a consistent relationship between compute, training data, and model capacity. As researchers grow model size and dataset volume, capabilities tend to improve smoothly and predictably, with occasional emergent abilities appearing at particular scale thresholds. This predictability has guided the design of increasingly capable systems, while raising real questions about energy use and cost.\n\nInference efficiency is now a central challenge. Quantization reduces the memory footprint and increases throughput by storing weights at lower numerical precision, allowing deployment on edge devices that would otherwise lack the necessary memory bandwidth. Speculative decoding and continuous batching push throughput further by using available compute more fully during autoregressive generation. Together these techniques make it practical to run capable models locally on consumer hardware, cutting latency and preserving privacy because data never leaves the device.\n\nReasoning quality continues to improve through chain-of-thought prompting and reinforcement learning from human feedback. Models with an explicit reasoning budget can spend more computation on hard problems while staying efficient on simple queries by disabling the reasoning trace entirely. Balancing this budget against latency and battery on mobile hardware is an open and practical engineering problem that the field is only beginning to address in production systems.\n\nOn mobile devices the constraints are sharper than on servers. Memory is limited, thermal headroom is small, and sustained throughput drops as the device heats up under a long generation. Prefill throughput, measured as prompt tokens processed per second, often behaves very differently from decode throughput, because prefill is compute bound across the whole prompt while decode is memory bound on a single token at a time. Quantization format interacts with both phases in ways that are hard to predict from first principles, which is exactly why empirical benchmarks across formats and devices matter. A format that is fast to decode on a desktop GPU may be slower on a phone because of how its blocks map onto the available kernels and cache hierarchy. Measuring time to first token, decode tokens per second, and prefill tokens per second across each quantization and reasoning setting gives the clearest practical picture of what users will actually experience.'
  }
]

// ~971-token prompt (verified against the Qwen3.5 tokenizer) for the batch
// sweep. batch-size only affects prefill throughput when the prompt spans more
// than one micro-batch, so this prompt is long enough that bs=512 chunks it into
// two prefill passes while bs=1024 does it in one — making the two batch sizes
// distinguishable at ctx-size 2048 (971 + 512 generated tokens stays in budget).
const BATCH_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  {
    role: 'user',
    content:
      "Summarize the following passage and explain its key technical implications for on-device inference.\n\nModern large language models have transformed natural language processing. Unlike earlier systems that relied on handcrafted features and task-specific architectures, transformer-based models learn general-purpose representations that transfer across many tasks. This shift enabled strong performance in text generation, translation, question answering, and code synthesis, frequently matching expert humans on established benchmarks.\n\nThe scaling laws governing these models describe a consistent relationship between compute, training data, and model capacity. As researchers grow model size and dataset volume, capabilities tend to improve smoothly and predictably, with occasional emergent abilities appearing at particular scale thresholds. This predictability has guided the design of increasingly capable systems, while raising real questions about energy use and cost.\n\nInference efficiency is now a central challenge. Quantization reduces the memory footprint and increases throughput by storing weights at lower numerical precision, allowing deployment on edge devices that would otherwise lack the necessary memory bandwidth. Speculative decoding and continuous batching push throughput further by using available compute more fully during autoregressive generation. Together these techniques make it practical to run capable models locally on consumer hardware, cutting latency and preserving privacy because data never leaves the device.\n\nOn mobile devices the constraints are sharper than on servers. Memory is limited, thermal headroom is small, and sustained throughput drops as the device heats up under a long generation. Prefill throughput, measured as prompt tokens processed per second, often behaves very differently from decode throughput, because prefill is compute bound across the whole prompt while decode is memory bound on a single token at a time.\n\nThe batch size and micro-batch size control how many prompt tokens the backend submits to the compute graph at once during prefill. They determine how the prompt is split into passes and how completely each pass saturates the accelerator. On a long prompt a larger micro-batch fills the available compute more fully, up to the point where occupancy saturates and scheduling overhead or cache pressure begins to erode the gain. That turning point differs by device and by model, which is precisely why the optimum is measured empirically rather than assumed.\n\nA configuration that is fast on a desktop GPU may be slower on a phone because of how its kernels map onto the available compute units and cache hierarchy. Adreno, Mali, and Apple GPUs each schedule work differently, so the batch size that maximizes prefill on one can leave another underutilized or thrashing memory. Measuring time to first token, decode tokens per second, and prefill tokens per second across each batch setting on real hardware gives the clearest practical picture of what users will actually experience during the first moments of a response.\n\nReasoning quality continues to improve through chain-of-thought prompting and reinforcement learning from human feedback. Models with an explicit reasoning budget can spend more computation on hard problems while staying efficient on simple queries by disabling the reasoning trace entirely. Balancing that budget against latency and battery on mobile hardware is an open and practical engineering problem, and the right answer depends on the prefill and decode throughput a given batch configuration actually delivers on the device in the user's hand.\n\nThe key-value cache adds another dimension to the prefill picture. As each prompt token is processed its attention keys and values are written to a cache whose memory footprint grows with context length, so a long prompt is bound not only by compute but by the bandwidth needed to populate and read that cache. Quantizing the cache reduces the footprint at some cost to accuracy, and its interaction with batch size is not obvious in advance: a larger micro-batch touches more of the cache per pass and can either hide or expose that bandwidth depending on the accelerator.\n\nThermal behavior complicates every measurement taken over more than a few seconds. A phone that starts a benchmark cool will throttle its clocks as the silicon warms, so a configuration measured first can look faster than an identical one measured later purely because of heat. Warming the kernels once before the timed runs, repeating each measurement several times, and reporting the spread are all necessary to separate a genuine batch-size effect from the drift introduced by thermal throttling and background system activity.\n\nFinally, the practical goal is not a single headline number but a map from configuration to experience. A product team choosing how to ship a model wants to know which batch size gives the lowest time to first token on the devices its users actually own, how that trades against sustained decode speed, and where the curve flattens so that spending more memory buys nothing. Building that map means sweeping the batch axis on real hardware and recording prefill throughput, decode throughput, and latency for each setting, then reading the results per device rather than averaging across a fleet that behaves nothing alike."
  }
]

function _envInt(key, fallback) {
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

function modelSpec(size, quant) {
  return {
    id: modelId(size, quant),
    name: modelFileName(size, quant),
    url: `https://huggingface.co/unsloth/Qwen3.5-${size}-GGUF/resolve/main/Qwen3.5-${size}-${quant}.gguf`
  }
}

async function runInference(addon, prompt, reasoningBudget) {
  const startTime = Date.now()
  const response = await addon.run(prompt, {
    generationParams: { reasoning_budget: parseInt(reasoningBudget, 10) }
  })
  const chunks = []
  let error = null
  response
    .onUpdate((data) => {
      chunks.push(data)
    })
    .onError((err) => {
      error = err
    })
  await response.await()
  if (error) throw new Error('inference failed: ' + error)
  return {
    output: chunks.join('').trim(),
    startTime,
    endTime: Date.now(),
    stats: response.stats || null
  }
}

// Records a placeholder row with no metrics. The renderer shows any row
// without TTFT/TPS/ppTPS as `Crashed`. We emit one up-front for every combo
// BEFORE loading/running it, so a hard native crash that kills the Device
// Farm session still leaves a `Crashed` row in the logs (the mobile reporter
// flushes each record to console immediately). A successful run records the
// real metrics afterwards, which supersedes the placeholder in the renderer.
function recordCrashedPlaceholder(label, device, model) {
  recordPerformance(label, 0, { stats: null, deviceId: device, scenario: 'benchmark-perf', model })
}

// Registers the benchmark test for one (model x quant x kv-cache type),
// sweeping device x reasoning-budget. One Device Farm session per call.
// kv-cache type is set as cache-type-k/v at load time. Adreno devices don't
// support quantized KV cache, and TurboQuant/PolarQuant (tbq*/pq*) ship Vulkan
// + CPU kernels only (rejected on Metal/iOS, unsupported on some GPUs), so
// those combos may crash or fail to load — reported as Crashed.
//
// batchSize is set only by the additive batch-sweep shards (see BATCH_SWEEP in
// _benchmark-matrix.js). When set, it pins batch-size === ubatch-size at load
// time, runs the longer BATCH_PROMPT so the batch actually spans multiple
// prefill passes, and tags the row label with [bs=N]. When null (every
// cross-product shard) the runner is byte-for-byte unchanged.
function benchmarkModel(size, quant, cacheK, cacheV, batchSize = null) {
  const spec = modelSpec(size, quant)
  // kvLabel uses the k/v form when key and value differ (e.g. TurboQuant
  // tbq3_0/pq3_0), matching the renderer's [kv=...] tag. kvId is the
  // slash-free token used for the model id and per-run identifiers.
  const kvLabel = cacheK === cacheV ? cacheK : `${cacheK}/${cacheV}`
  const kvId = cacheK === cacheV ? cacheK : `${cacheK}-${cacheV}`
  const bsLabel = batchSize !== null ? ` [bs=${batchSize}]` : ''
  const bsId = batchSize !== null ? `-bs${batchSize}` : ''
  const batchConfig =
    batchSize !== null ? { 'batch-size': String(batchSize), 'ubatch-size': String(batchSize) } : {}
  const prompt = batchSize !== null ? BATCH_PROMPT : PROMPT
  const id = `${spec.id}-${kvId}${bsId}`
  safeTest(
    `Mobile perf benchmark: ${id} (TTFT / TPS / ppTPS)`,
    {
      timeout: 1_800_000,
      skip: !isMobile
    },
    async (t) => {
      const specLogger = attachSpecLogger({ forwardToConsole: true })
      try {
        const [modelName, dirPath] = await ensureModel({
          modelName: spec.name,
          downloadUrl: spec.url
        })
        const modelPath = path.join(dirPath, modelName)

        // Up-front Crashed placeholders for EVERY combo across BOTH devices before
        // any load/run, so a hard native crash during the first device's pass still
        // leaves rows for the other device. Real metrics supersede these.
        for (const device of DEVICES) {
          for (const rb of REASONING_BUDGETS) {
            recordCrashedPlaceholder(
              `[${spec.id}] [${device}] [rb=${rb}] [kv=${kvLabel}]${bsLabel}`,
              device,
              `${id}-${device}-rb${rb}`
            )
          }
        }

        for (const device of DEVICES) {
          const labelFor = (rb) => `[${spec.id}] [${device}] [rb=${rb}] [kv=${kvLabel}]${bsLabel}`
          const modelFor = (rb) => `${id}-${device}-rb${rb}`

          let addon = null
          try {
            addon = new LlmLlamacpp({
              files: { model: [modelPath] },
              config: {
                ...RUNTIME,
                device,
                'cache-type-k': cacheK,
                'cache-type-v': cacheV,
                ...batchConfig
              },
              logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
              opts: { stats: true }
            })
            await addon.load()
          } catch (loadErr) {
            // Load failed (e.g. unsupported quantized KV cache) — placeholders
            // remain Crashed for this device's combos. Move on.
            t.comment(
              `[${id}] [${device}] load failed (reported as Crashed): ${loadErr && loadErr.message ? loadErr.message : loadErr}`
            )
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
                const { endTime, startTime } = await runInference(
                  addon,
                  prompt,
                  REASONING_BUDGETS[0]
                )
                t.comment(
                  `[${id}] [${device}] warmup ${w}/${PERF_WARMUP_RUNS} (${endTime - startTime}ms) - perf NOT recorded`
                )
              }
            } catch (warmErr) {
              t.comment(
                `[${id}] [${device}] warmup failed: ${warmErr && warmErr.message ? warmErr.message : warmErr}`
              )
            }
            for (const rb of REASONING_BUDGETS) {
              const label = labelFor(rb)
              try {
                for (let run = 1; run <= PERF_RUNS; run++) {
                  const { output, startTime, endTime, stats } = await runInference(
                    addon,
                    prompt,
                    rb
                  )
                  // Real metrics supersede the Crashed placeholder in the renderer.
                  t.comment(
                    recordPerformance(label, endTime - startTime, {
                      stats,
                      deviceId: device,
                      scenario: 'benchmark-perf',
                      model: modelFor(rb)
                    })
                  )
                  t.ok(output.length > 0, `${label} run ${run}/${PERF_RUNS} produced output`)
                }
              } catch (runErr) {
                // Catchable run failure — placeholder stays Crashed for this combo.
                t.comment(
                  `${label} run failed (reported as Crashed): ${runErr && runErr.message ? runErr.message : runErr}`
                )
              }
            }
          } finally {
            await addon.unload().catch(() => {})
          }
        }
      } finally {
        specLogger.release()
      }
    }
  )
}

module.exports = { benchmarkModel, modelSpec }
