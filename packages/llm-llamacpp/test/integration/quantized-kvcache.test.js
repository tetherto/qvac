'use strict'

// Quantized KV-cache smoke tests.
//
// This file exercises the cache-type combinations supported by llama.cpp plus
// Tether TurboQuant / PolarQuant formats across representative attention head
// dimensions. It intentionally avoids performance assertions because CI timing
// is noisy across GPU drivers and hosted runners; the tests only assert that
// supported cache configurations load, generate tokens, and report smaller
// TBQ/PQ KV memory than f16 when native stats are available.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const isDarwin = platform === 'darwin'
const isIos = platform === 'ios'

// TurboQuant/PolarQuant formats currently require a Vulkan backend on
// Linux/Windows x64 or a supported Android GPU. On other platforms the
// addon throws `TurboQuant ... not supported` during model load; the smoke tests
// detect that and skip the offending rows instead of failing. Apple
// Metal/iOS paths are not target backends for this coverage, so skip them.
// Some Android GPUs (e.g. Galaxy S25 / Adreno 830 in CI) can time out even
// on the first f16+f16 row, so these smoke tests are disabled on Android.
const isAndroid = platform === 'android'
const skipReason = isDarwin || isIos
  ? 'Quantized KV cache smoke tests are skipped on Apple Metal/iOS targets'
  : isAndroid
    ? 'Quantized KV cache smoke tests are skipped on Android GPU CI'
    : false

const MODEL_3B = {
  name: 'llama-3.2-3b-instruct-q4_0.gguf',
  url: 'https://huggingface.co/lahirum/Llama-3.2-3B-Instruct-Q4_0-GGUF/resolve/main/llama-3.2-3b-instruct-q4_0.gguf',
  headDim: 128
}
const MODEL_1B = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
  headDim: 64
}
const MODEL_QWEN35_08B = {
  name: 'Qwen3.5-0.8B-Q4_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_0.gguf?download=true',
  headDim: 256
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful, respectful and honest assistant.' },
  { role: 'user', content: 'Explain what a neural network is in two sentences.' }
]

// Ordered: f16 first so it is always the reference baseline, followed by
// "standard" ggml quant caches, then the TurboQuant/PolarQuant family.
const CACHE_CONFIGS = [
  { label: 'f16+f16', k: 'f16', v: 'f16', kind: 'standard' },
  { label: 'q8_0+q8_0', k: 'q8_0', v: 'q8_0', kind: 'standard' },
  { label: 'q4_0+q4_0', k: 'q4_0', v: 'q4_0', kind: 'standard' },
  { label: 'pq3_0+pq3_0', k: 'pq3_0', v: 'pq3_0', kind: 'tbqpq' },
  { label: 'tbq3_0+pq3_0', k: 'tbq3_0', v: 'pq3_0', kind: 'tbqpq' },
  { label: 'pq4_0+pq4_0', k: 'pq4_0', v: 'pq4_0', kind: 'tbqpq' },
  { label: 'tbq4_0+pq4_0', k: 'tbq4_0', v: 'pq4_0', kind: 'tbqpq' },
  { label: 'tbq4_0+pq3_0', k: 'tbq4_0', v: 'pq3_0', kind: 'tbqpq' },
  { label: 'pq3_0+pq4_0', k: 'pq3_0', v: 'pq4_0', kind: 'tbqpq' }
]

// Memory must be strictly smaller; the extra epsilon avoids false fails
// if the parsed value rounds identically in rare configurations.
const MEM_EPSILON_MIB = 0.1

function normalizeStats (rawStats = {}) {
  return {
    CacheTokens: Number(rawStats.CacheTokens || rawStats.cacheTokens || 0),
    contextSlides: Number(rawStats.contextSlides || 0)
  }
}

// Extract the KV-cache size (MiB) for the current smoke run from the native
// llama.cpp logs. Two defences against cross-test log leakage:
//
//   1. Scan from the END of the log buffer: the current smoke run's
//      `llama_kv_cache: size = ...` line is always the most recent one,
//      while earlier tests (or the buffered flush that happens the first
//      time `setLogger` is installed after a previous model instance ran)
//      appear earlier in `logs`.
//   2. If `cfg` is provided, require the line to also mention the
//      expected `K (<k>)` and `V (<v>)` quant tags. `cache-type-k` /
//      `cache-type-v` can be passed as `f16`, `q8_0`, `pq3_0`, etc. and
//      llama.cpp echoes them verbatim inside that line, e.g.
//      `K (pq3_0):   21.88 MiB, V (pq3_0):   21.88 MiB`. This guarantees
//      we never attribute another test's KV-cache line to our smoke run.
//
// Example line:
//   llama_kv_cache: size =   12.91 MiB ( 512 cells, 28 layers, ...), K (tbq3_0): 7.44 MiB, V (pq3_0): 5.47 MiB
function parseKvCacheMiB (logs, cfg) {
  const sizeRe = /llama_kv_cache:\s*size\s*=\s*([\d.]+)\s*MiB/
  const kTag = cfg && cfg.k ? `K (${cfg.k}` : null
  const vTag = cfg && cfg.v ? `V (${cfg.v}` : null
  let fallback = null
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i]
    const match = line.match(sizeRe)
    if (!match) continue
    if (kTag && vTag) {
      if (line.includes(kTag) && line.includes(vTag)) {
        return parseFloat(match[1])
      }
      continue
    }
    if (fallback === null) fallback = parseFloat(match[1])
  }
  return fallback
}

function isTurboQuantUnsupported (err) {
  return /TurboQuant.*not supported/i.test(err && err.message ? err.message : '')
}

async function runAndCollect (model, prompt, runOptions) {
  const response = await model.run(prompt, runOptions)
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()

  return {
    output: chunks.join(''),
    stats: normalizeStats(response.stats)
  }
}

async function runBenchmark (cfg, modelInfo) {
  const [modelName, dirPath] = await ensureModel({
    modelName: modelInfo.name,
    downloadUrl: modelInfo.url
  })

  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const model = new LlmLlamacpp({
    files: { model: [path.join(dirPath, modelName)] },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      ctx_size: '2048',
      n_predict: '128',
      temp: '0.7',
      seed: '42',
      verbosity: '2',
      'flash-attn': 'on',
      'cache-type-k': cfg.k,
      'cache-type-v': cfg.v
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await model.load()

    const response = await model.run(PROMPT)
    const chunks = []
    await response.onUpdate(data => { chunks.push(data) }).await()
    const output = chunks.join('').trim()

    const stats = response.stats || {}
    const kvCacheMiB = parseKvCacheMiB(specLogger.logs, cfg)

    return {
      output,
      kvCacheMiB,
      generatedTokens: stats.generatedTokens || 0
    }
  } finally {
    await model.unload().catch(() => { })
    specLogger.release()
  }
}

async function runPrefillSlidingSmoke (t, cfg, modelInfo, label) {
  const [modelName, dirPath] = await ensureModel({
    modelName: modelInfo.name,
    downloadUrl: modelInfo.url
  })

  const cachePath = path.join(dirPath, `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-prefill-sliding-cache.bin`)
  try { fs.unlinkSync(cachePath) } catch (_) {}

  const model = new LlmLlamacpp({
    files: { model: [path.join(dirPath, modelName)] },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      ctx_size: '512',
      n_discarded: '64',
      temp: '0',
      seed: '42',
      verbosity: '2',
      'cache-type-k': cfg.k
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await model.load()

    const seedRun = await runAndCollect(model, [
      { role: 'system', content: 'You are a storyteller. Write detailed stories with many characters.' },
      { role: 'user', content: 'Continue with simple filler words until you reach the token limit.' }
    ], {
      cacheKey: cachePath,
      saveCacheToDisk: true,
      generationParams: {
        predict: 160,
        seed: 42,
        temp: 0,
        top_k: 1
      }
    })

    t.ok(seedRun.output.length > 0, `${label}: seeded cache`)

    const run = await runAndCollect(model, [
      {
        role: 'user',
        content: `Answer "ok" after reading this prefill pressure. ${' blue'.repeat(440)}`
      }
    ], {
      cacheKey: cachePath,
      saveCacheToDisk: true,
      generationParams: {
        predict: 8,
        seed: 42,
        temp: 0,
        top_k: 1
      }
    })

    t.ok(run.output.length > 0, `${label}: produced output after prefill slide`)
    t.ok(run.stats.contextSlides > 0, `${label}: exercised prefill context sliding`)
    t.ok(run.stats.CacheTokens < 512, `${label}: cache stays within context (${run.stats.CacheTokens})`)
  } catch (err) {
    if (isTurboQuantUnsupported(err)) {
      t.comment(`${label}: SKIPPED (tbq/pq unsupported on this backend: ${err.message})`)
      return
    }
    throw err
  } finally {
    try { fs.unlinkSync(cachePath) } catch (_) {}
    await model.unload().catch(() => { })
  }
}

async function runHeadDimSmoke (t, modelInfo, label) {
  const results = []

  for (const cfg of CACHE_CONFIGS) {
    console.log(`\n====== Running ${label} head_dim=${modelInfo.headDim} smoke: ${cfg.label} ======`)
    try {
      const result = await runBenchmark(cfg, modelInfo)
      results.push({ cfg, result })
      t.ok(result.output.length > 0, `${cfg.label}: produced output`)
      t.ok(result.generatedTokens > 0, `${cfg.label}: generated tokens (${result.generatedTokens})`)
    } catch (err) {
      if (cfg.kind === 'tbqpq' && isTurboQuantUnsupported(err)) {
        t.comment(`${cfg.label}: SKIPPED (tbq/pq unsupported on this backend: ${err.message})`)
        continue
      }
      throw err
    }
  }

  const f16 = results.find(r => r.cfg.label === 'f16+f16')?.result
  const tbq3pq3 = results.find(r => r.cfg.label === 'tbq3_0+pq3_0')?.result
  t.ok(f16, `${label} head_dim=${modelInfo.headDim} f16 baseline completed`)
  t.ok(tbq3pq3, `${label} head_dim=${modelInfo.headDim} TBQ/PQ cache completed`)

  if (f16?.kvCacheMiB != null && tbq3pq3?.kvCacheMiB != null) {
    const pct = (tbq3pq3.kvCacheMiB / f16.kvCacheMiB) * 100
    t.ok(
      tbq3pq3.kvCacheMiB + MEM_EPSILON_MIB < f16.kvCacheMiB,
      `${label} head_dim=${modelInfo.headDim} TBQ/PQ KV memory (${tbq3pq3.kvCacheMiB.toFixed(2)} MiB, ${pct.toFixed(0)}% of f16) < f16 (${f16.kvCacheMiB.toFixed(2)} MiB)`
    )
  }
}

test('Quantized KV cache head_dim=64 smoke: Llama 3.2 1B TBQ/PQ', { skip: skipReason, timeout: 900_000 }, async t => {
  await runHeadDimSmoke(t, MODEL_1B, 'Llama 3.2 1B')
})

test('Quantized KV cache head_dim=128 smoke: Llama 3.2 3B TBQ/PQ', { skip: skipReason, timeout: 900_000 }, async t => {
  await runHeadDimSmoke(t, MODEL_3B, 'Llama 3.2 3B')
})

test('Quantized KV cache head_dim=128 prefill sliding: Llama 3.2 3B pq4 K-cache', { skip: skipReason, timeout: 900_000 }, async t => {
  await runPrefillSlidingSmoke(t, { k: 'pq4_0' }, MODEL_3B, 'Llama 3.2 3B pq4 K-cache')
})

test('Quantized KV cache head_dim=128 prefill sliding: Llama 3.2 3B tbq4 K-cache', { skip: skipReason, timeout: 900_000 }, async t => {
  await runPrefillSlidingSmoke(t, { k: 'tbq4_0' }, MODEL_3B, 'Llama 3.2 3B tbq4 K-cache')
})

test('Quantized KV cache head_dim=256 smoke: Qwen3.5 TBQ/PQ', { skip: skipReason, timeout: 900_000 }, async t => {
  await runHeadDimSmoke(t, MODEL_QWEN35_08B, 'Qwen3.5')
})
