'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()

const DEFAULT_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful, respectful and honest assistant.' },
  { role: 'user', content: 'Explain what a neural network is in two sentences.' }
]

const CACHE_CONFIGS = [
  { label: 'f16+f16', k: 'f16', v: 'f16' },
  { label: 'q8_0+q8_0', k: 'q8_0', v: 'q8_0' },
  { label: 'q4_0+q4_0', k: 'q4_0', v: 'q4_0' }
]

function parseKvCacheMiB (logs) {
  for (const line of logs) {
    const match = line.match(/llama_kv_cache: size\s*=\s*([\d.]+)\s*MiB/)
    if (match) return parseFloat(match[1])
  }
  return null
}

function parseHardwareInfo (logs) {
  let gpuName = null
  let backend = null

  for (const line of logs) {
    const match = line.match(/Backend detected: description\s*=\s*(.+?),\s*backend\s*=\s*(\S+),\s*type\s*=\s*GPU/)
    if (match) {
      gpuName = match[1].trim()
      backend = match[2].trim()
      break
    }
  }

  return { gpuName, backend }
}

async function runBenchmark (cacheTypeK, cacheTypeV) {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
    n_predict: '128',
    temp: '0.7',
    seed: '42',
    verbosity: '2',
    'flash-attn': 'on',
    'cache-type-k': cacheTypeK,
    'cache-type-v': cacheTypeV
  }

  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)

  try {
    await model.load()

    const response = await model.run(PROMPT)
    const chunks = []
    await response.onUpdate(data => { chunks.push(data) }).await()
    const output = chunks.join('').trim()

    const stats = response.stats || {}
    const kvCacheMiB = parseKvCacheMiB(specLogger.logs)

    const promptTokens = stats.promptTokens || 0
    const ttftMs = stats.TTFT || 0
    const tps = stats.TPS || 0
    const promptEvalTps = ttftMs > 0 ? (promptTokens / (ttftMs / 1000)) : 0
    const perTokenLatencyMs = tps > 0 ? (1000 / tps) : 0

    const hwInfo = parseHardwareInfo(specLogger.logs)

    return {
      output,
      kvCacheMiB,
      promptEvalTps,
      generationTps: tps,
      perTokenLatencyMs,
      promptTokens,
      generatedTokens: stats.generatedTokens || 0,
      ttftMs,
      gpuName: hwInfo.gpuName,
      backend: hwInfo.backend
    }
  } finally {
    await model.unload().catch(() => { })
    await loader.close().catch(() => { })
    specLogger.release()
  }
}

function printTable (results) {
  const labels = CACHE_CONFIGS.map(c => c.label)
  const colWidth = 14

  const pad = (s, w) => {
    const str = String(s)
    return str.length >= w ? str : str + ' '.repeat(w - str.length)
  }
  const rpad = (s, w) => {
    const str = String(s)
    return str.length >= w ? str : ' '.repeat(w - str.length) + str
  }

  const firstResult = results.find(r => r !== null)
  const gpuName = firstResult?.gpuName || 'unknown'
  const backend = firstResult?.backend || 'unknown'

  const headerRow = pad('', 22) + labels.map(l => rpad(l, colWidth)).join('')
  const sep = '-'.repeat(headerRow.length)

  console.log('\n' + sep)
  console.log('  Quantized KV Cache Benchmark')
  console.log('  Model:    ' + DEFAULT_MODEL.name)
  console.log('  Hardware: ' + gpuName)
  console.log('  Backend:  ' + backend)
  console.log('  Platform: ' + platform + '/' + os.arch())
  console.log(sep)
  console.log(headerRow)
  console.log(sep)

  const rows = [
    ['KV cache (MiB)', r => r ? r.kvCacheMiB?.toFixed(2) || 'n/a' : 'FAIL'],
    ['Prompt eval (t/s)', r => r ? r.promptEvalTps?.toFixed(1) || 'n/a' : 'FAIL'],
    ['Generation (t/s)', r => r ? r.generationTps?.toFixed(1) || 'n/a' : 'FAIL'],
    ['Per-token latency (ms)', r => r ? r.perTokenLatencyMs?.toFixed(2) || 'n/a' : 'FAIL'],
    ['TTFT (ms)', r => r ? r.ttftMs?.toFixed(1) || 'n/a' : 'FAIL'],
    ['Generated tokens', r => r ? String(r.generatedTokens) : 'FAIL']
  ]

  for (const [label, fn] of rows) {
    const values = results.map(r => rpad(fn(r), colWidth))
    console.log(pad(label, 22) + values.join(''))
  }

  console.log(sep + '\n')
}

test('Quantized KV cache benchmark: f16 vs q8_0 vs q4_0', { timeout: 900_000 }, async t => {
  const results = []

  for (const cfg of CACHE_CONFIGS) {
    console.log(`\n====== Running benchmark: ${cfg.label} ======`)
    try {
      const result = await runBenchmark(cfg.k, cfg.v)
      results.push(result)

      t.ok(result.output.length > 0, `${cfg.label}: produced output`)
      t.ok(result.generatedTokens > 0, `${cfg.label}: generated tokens (${result.generatedTokens})`)
    } catch (err) {
      console.error(`${cfg.label} benchmark failed:`, err.message)
      results.push(null)
      t.comment(`${cfg.label}: FAILED - ${err.message}`)
    }
  }

  printTable(results)

  const successCount = results.filter(r => r !== null).length
  t.ok(successCount >= 2, `at least 2 of 3 cache configs succeeded (${successCount}/3)`)

  const MARGIN = 0.15
  const [f16Result, q8Result, q4Result] = results

  // -- KV cache memory checks --
  // Quantized KV types store fewer bits per element, so the KV buffer must be
  // strictly smaller than the f16 baseline.
  if (f16Result && q8Result) {
    t.ok(
      q8Result.kvCacheMiB < f16Result.kvCacheMiB,
      `q8_0 KV memory (${q8Result.kvCacheMiB} MiB) < f16 KV memory (${f16Result.kvCacheMiB} MiB)`
    )
  }

  if (f16Result && q4Result) {
    t.ok(
      q4Result.kvCacheMiB < f16Result.kvCacheMiB,
      `q4_0 KV memory (${q4Result.kvCacheMiB} MiB) < f16 KV memory (${f16Result.kvCacheMiB} MiB)`
    )
  }

  // -- TTFT checks --
  // Prompt evaluation (prefill) is memory-bandwidth bound: every input token
  // writes its K and V projections into the cache in bulk. Smaller cache types
  // (q8_0, q4_0) transfer less data over the memory bus, so TTFT should be
  // equal to or lower than the f16 baseline within a tolerance margin.
  if (f16Result && q8Result) {
    const ceiling = f16Result.ttftMs * (1 + MARGIN)
    t.ok(
      q8Result.ttftMs <= ceiling,
      `q8_0 TTFT (${q8Result.ttftMs.toFixed(1)} ms) <= f16 TTFT (${f16Result.ttftMs.toFixed(1)} ms) + 15% margin (${ceiling.toFixed(1)} ms)`
    )
  }

  if (f16Result && q4Result) {
    const ceiling = f16Result.ttftMs * (1 + MARGIN)
    t.ok(
      q4Result.ttftMs <= ceiling,
      `q4_0 TTFT (${q4Result.ttftMs.toFixed(1)} ms) <= f16 TTFT (${f16Result.ttftMs.toFixed(1)} ms) + 15% margin (${ceiling.toFixed(1)} ms)`
    )
  }

  // -- Prompt eval throughput checks --
  // Same reasoning as TTFT: less memory traffic during prefill means prompt
  // eval tokens/s should be at least as fast as f16 (within tolerance).
  if (f16Result && q8Result) {
    const floor = f16Result.promptEvalTps * (1 - MARGIN)
    t.ok(
      q8Result.promptEvalTps >= floor,
      `q8_0 prompt eval (${q8Result.promptEvalTps.toFixed(1)} t/s) >= f16 (${f16Result.promptEvalTps.toFixed(1)} t/s) - 15% margin (${floor.toFixed(1)} t/s)`
    )
  }

  if (f16Result && q4Result) {
    const floor = f16Result.promptEvalTps * (1 - MARGIN)
    t.ok(
      q4Result.promptEvalTps >= floor,
      `q4_0 prompt eval (${q4Result.promptEvalTps.toFixed(1)} t/s) >= f16 (${f16Result.promptEvalTps.toFixed(1)} t/s) - 15% margin (${floor.toFixed(1)} t/s)`
    )
  }

  // NOTE: generation (decode) speed is NOT expected to improve with quantized
  // KV cache. Decode processes one token at a time, so it is compute-bound
  // (attention matmul, FFN) rather than memory-bandwidth-bound. The KV cache
  // read per token is a small fraction of total decode work, so shrinking it
  // has negligible impact on tokens/s.
})
