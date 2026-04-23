'use strict'

// Quantized KV-cache benchmark & sanity test.
//
// This test exercises the range of KV-cache quantization types supported by
// the llama.cpp backend and the Tether-specific TurboQuant / PolarQuant
// formats (tbq3_0, tbq4_0, pq3_0, pq4_0). For every config it measures KV
// memory footprint, prompt-eval throughput (prefill), generation throughput
// (decode), TTFT and per-token latency. Values are printed in a compact
// table and then cross-checked against the f16+f16 baseline to catch
// obvious regressions:
//
//   * memory: quantized caches MUST be smaller than f16+f16, and we also
//     report the ratio as a percentage of f16 so the reduction is easy to
//     eyeball (q8 ~= 50%, q4/pq4 ~= 25-30%, pq3/tbq3 ~= 20%).
//   * TTFT / prompt-eval: smaller KV data moving over the memory bus SHOULD
//     translate into prefill that is at least as fast as f16 within a
//     generous margin; flaky CI runners get a wider tolerance.
//   * tbq vs pq: K-only TurboQuant (`tbq*`) is a wrapper that keeps Keys in
//     their native tbq layout and pairs them with a PolarQuant V. Pure
//     PolarQuant (pq*+pq*) should be as fast or slightly faster than the
//     matching `tbq*+pq*` configuration because there is no extra K-side
//     unpack step.
//
// IMPORTANT: decode (generation) throughput is NOT expected to improve with
// quantized KV cache, it is compute bound. Also, on some hardware (notably
// GPUs with fast native fp16 ALUs, e.g. recent NVIDIA/AMD discrete and
// Apple Silicon) f16+f16 can actually be faster than q4_0+q4_0 during
// decode: the quantized path has to dequantize K/V on every attention step,
// whereas f16 can be consumed directly by the matmul. For that reason we
// only assert that quantized configs are NOT drastically slower, we do not
// assert they are faster.

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()

// TurboQuant/PolarQuant formats currently require a Vulkan backend on
// Linux/Windows x64 or a supported Android GPU. On other platforms the
// addon throws `TurboQuant ... not supported` during model load; the test
// detects that and skips the offending rows instead of failing.
const isDesktopGpu = (platform === 'linux' || platform === 'win32') && arch === 'x64'
const isAndroid = platform === 'android'
const tbqPqSupported = isDesktopGpu || isAndroid

// Model selection by platform.
//
// Desktop CI (and any non-Android host) runs the 3B Instruct Q4_0
// (head_dim=128) for consistency with `turboquant.test.js` — larger KV
// sizes give more statistically meaningful MiB comparisons.
//
// On Android we fall back to the 1B Instruct Q4_0 (head_dim=64) so the
// test fits comfortably even on 4-6 GB devices. The internal tbq/pq
// kernels auto-pick the head_dim variant (`_64` vs native 128) based on
// the model, so the assertion logic is identical for both.
const MODEL_3B = {
  name: 'llama-3.2-3b-instruct-q4_0.gguf',
  url: 'https://huggingface.co/lahirum/Llama-3.2-3B-Instruct-Q4_0-GGUF/resolve/main/llama-3.2-3b-instruct-q4_0.gguf'
}
const MODEL_1B = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}
const DEFAULT_MODEL = isAndroid ? MODEL_1B : MODEL_3B

const PROMPT = [
  { role: 'system', content: 'You are a helpful, respectful and honest assistant.' },
  { role: 'user', content: 'Explain what a neural network is in two sentences.' }
]

// Ordered: f16 first so it is always the reference baseline, followed by
// "standard" ggml quant caches, then the TurboQuant/PolarQuant family.
//
// On Android we exercise a reduced TurboQuant/PolarQuant sweep (pq3+pq3
// and tbq3+pq3 only) to keep the mobile wall-time and memory pressure
// reasonable — those two cover the "pure pq vs tbq wrapper" signal and
// pair with the memory / prefill invariants asserted later.
const DESKTOP_CACHE_CONFIGS = [
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
const ANDROID_CACHE_CONFIGS = [
  { label: 'f16+f16', k: 'f16', v: 'f16', kind: 'standard' },
  { label: 'q8_0+q8_0', k: 'q8_0', v: 'q8_0', kind: 'standard' },
  { label: 'q4_0+q4_0', k: 'q4_0', v: 'q4_0', kind: 'standard' },
  { label: 'pq3_0+pq3_0', k: 'pq3_0', v: 'pq3_0', kind: 'tbqpq' },
  { label: 'tbq3_0+pq3_0', k: 'tbq3_0', v: 'pq3_0', kind: 'tbqpq' }
]
const CACHE_CONFIGS = isAndroid ? ANDROID_CACHE_CONFIGS : DESKTOP_CACHE_CONFIGS

// Tolerance margins. We keep them generous on purpose to avoid CI
// flakiness: GitHub-hosted runners share hardware and the measurement
// window (128 generated tokens, low-single-digit seconds) is small, so
// run-to-run jitter of 10-20% on throughput/TTFT is normal.
//
// For prefill (TTFT + prompt-eval t/s) we intentionally do NOT compare
// against f16: on backends with fully hardware-fused f16 attention
// kernels (Vulkan on NVIDIA, Metal on Apple, some ROCm paths) the f16
// prefill is 10-20x faster than ANY quantized cache because quantized
// prefill falls back to a slower generic path. We therefore use q8_0
// as the reference: it is the closest quantized configuration to f16
// in memory layout and any wildly broken quant variant would also be
// wildly slower than q8_0.
const PREFILL_REFERENCE_LABEL = 'q8_0+q8_0'
const TTFT_MARGIN = 3.0 // prefill TTFT may be up to 4x the q8_0 reference
const PROMPT_EVAL_MARGIN = 0.75 // prompt-eval t/s floor at 25% of q8_0
// Decode is compute-bound and surprisingly close across configs even
// when prefill isn't, so we keep the decode check anchored to f16 with
// a generous floor (see rationale below).
const DECODE_MARGIN = 0.40 // decode t/s floor at 60% of f16
// Memory must be strictly smaller; the extra epsilon avoids false fails
// if the parsed value rounds identically in rare configurations.
const MEM_EPSILON_MIB = 0.1

// Extract the KV-cache size (MiB) for the current benchmark from the native
// llama.cpp logs. Two defences against cross-test log leakage:
//
//   1. Scan from the END of the log buffer: the current benchmark's
//      `llama_kv_cache: size = ...` line is always the most recent one,
//      while earlier tests (or the buffered flush that happens the first
//      time `setLogger` is installed after a previous model instance ran)
//      appear earlier in `logs`.
//   2. If `cfg` is provided, require the line to also mention the
//      expected `K (<k>)` and `V (<v>)` quant tags. `cache-type-k` /
//      `cache-type-v` can be passed as `f16`, `q8_0`, `pq3_0`, etc. and
//      llama.cpp echoes them verbatim inside that line, e.g.
//      `K (pq3_0):   21.88 MiB, V (pq3_0):   21.88 MiB`. This guarantees
//      we never attribute another test's KV-cache line to our benchmark.
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

function parseHardwareInfo (logs) {
  let gpuName = null
  let backend = null

  for (const line of logs) {
    const match = line.match(/Backend detected: description\s*=\s*(.+?),\s*backend\s*=\s*(\S+),\s*type\s*=\s*(?:GPU|IGPU)/)
    if (match) {
      gpuName = match[1].trim()
      backend = match[2].trim()
      break
    }
  }

  return { gpuName, backend }
}

function isTurboQuantUnsupported (err) {
  return /TurboQuant.*not supported/i.test(err && err.message ? err.message : '')
}

async function runBenchmark (cfg) {
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
    'cache-type-k': cfg.k,
    'cache-type-v': cfg.v
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
    const kvCacheMiB = parseKvCacheMiB(specLogger.logs, cfg)

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
  const colWidth = 14
  const labelWidth = 24

  const lpad = (s, w) => {
    const str = String(s)
    return str.length >= w ? str : str + ' '.repeat(w - str.length)
  }
  const rpad = (s, w) => {
    const str = String(s)
    return str.length >= w ? str : ' '.repeat(w - str.length) + str
  }

  const firstResult = results.find(r => r && r.result)
  const gpuName = (firstResult && firstResult.result.gpuName) || 'unknown'
  const backend = (firstResult && firstResult.result.backend) || 'unknown'

  const labels = results.map(r => r.cfg.label)
  const headerRow = lpad('', labelWidth) + labels.map(l => rpad(l, colWidth)).join('')
  const sep = '-'.repeat(headerRow.length)

  console.log('\n' + sep)
  console.log('  Quantized KV Cache Benchmark')
  console.log('  Model:    ' + DEFAULT_MODEL.name)
  console.log('  Hardware: ' + gpuName)
  console.log('  Backend:  ' + backend)
  console.log('  Platform: ' + platform + '/' + arch)
  console.log(sep)
  console.log(headerRow)
  console.log(sep)

  // Baseline used for the memory-% column.
  const f16 = results.find(r => r.cfg.label === 'f16+f16' && r.result)
  const f16Mem = f16 && f16.result.kvCacheMiB

  const fmt = (r, fn) => {
    if (!r.result) return r.skipped ? 'SKIP' : 'FAIL'
    const v = fn(r.result)
    return (v === null || v === undefined) ? 'n/a' : v
  }

  const rows = [
    ['KV cache (MiB)', r => r.kvCacheMiB != null ? r.kvCacheMiB.toFixed(2) : null],
    ['KV vs f16 (%)', r => (f16Mem && r.kvCacheMiB != null) ? ((r.kvCacheMiB / f16Mem) * 100).toFixed(0) + '%' : null],
    ['Prompt eval (t/s)', r => r.promptEvalTps ? r.promptEvalTps.toFixed(1) : null],
    ['Generation (t/s)', r => r.generationTps ? r.generationTps.toFixed(1) : null],
    ['Per-token lat. (ms)', r => r.perTokenLatencyMs ? r.perTokenLatencyMs.toFixed(2) : null],
    ['TTFT (ms)', r => r.ttftMs ? r.ttftMs.toFixed(1) : null],
    ['Generated tokens', r => String(r.generatedTokens)]
  ]

  for (const [label, fn] of rows) {
    const values = results.map(r => rpad(fmt(r, fn), colWidth))
    console.log(lpad(label, labelWidth) + values.join(''))
  }

  console.log(sep + '\n')
}

test('Quantized KV cache benchmark: f16 / q8 / q4 / tbq / pq', { timeout: 1800_000 }, async t => {
  const results = CACHE_CONFIGS.map(cfg => ({ cfg, result: null, skipped: false, error: null }))

  for (const entry of results) {
    const { cfg } = entry
    console.log(`\n====== Running benchmark: ${cfg.label} ======`)
    try {
      entry.result = await runBenchmark(cfg)
      t.ok(entry.result.output.length > 0, `${cfg.label}: produced output`)
      t.ok(entry.result.generatedTokens > 0, `${cfg.label}: generated tokens (${entry.result.generatedTokens})`)
    } catch (err) {
      const unsupported = isTurboQuantUnsupported(err) ||
        (cfg.kind === 'tbqpq' && !tbqPqSupported)
      if (unsupported) {
        entry.skipped = true
        t.comment(`${cfg.label}: SKIPPED (tbq/pq unsupported on this backend: ${err.message || 'platform gated'})`)
      } else {
        entry.error = err
        console.error(`${cfg.label} benchmark failed:`, err.message)
        t.comment(`${cfg.label}: FAILED - ${err.message}`)
      }
    }
  }

  printTable(results)

  // A successful run needs f16 (our reference) plus at least one other
  // config; otherwise the comparisons below are meaningless.
  const successResults = results.filter(r => r.result)
  t.ok(
    successResults.length >= 2,
    `at least 2 cache configs succeeded (${successResults.length}/${results.length})`
  )

  const byLabel = {}
  for (const r of results) if (r.result) byLabel[r.cfg.label] = r.result
  const f16 = byLabel['f16+f16']

  if (!f16) {
    t.comment('f16+f16 baseline missing; skipping cross-config comparisons')
    return
  }

  // -- Memory checks (expressed as a % of f16 to make the reduction obvious) --
  // Quantized KV types store fewer bits per element, so the KV buffer must
  // be strictly smaller than the f16 baseline. q8_0 is expected around 50%,
  // q4_0/pq4 around 25-30%, pq3/tbq3 around ~20%.
  for (const r of results) {
    const res = r.result
    if (!res || r.cfg.label === 'f16+f16') continue
    if (res.kvCacheMiB == null || f16.kvCacheMiB == null) continue
    const pct = (res.kvCacheMiB / f16.kvCacheMiB) * 100
    t.ok(
      res.kvCacheMiB + MEM_EPSILON_MIB < f16.kvCacheMiB,
      `${r.cfg.label} KV memory (${res.kvCacheMiB.toFixed(2)} MiB, ${pct.toFixed(0)}% of f16) < f16 (${f16.kvCacheMiB.toFixed(2)} MiB)`
    )
  }

  // Explicit tighter bands for the well-known standard quants. f16 stores
  // 16 bits/elem, q8_0 ~= 8.5 bits/elem (-> ~55%), q4_0 ~= 4.5 bits/elem
  // (-> ~28%). Allow a generous ±10-percentage-point slack for block
  // overhead and padding.
  const q8 = byLabel['q8_0+q8_0']
  const q4 = byLabel['q4_0+q4_0']
  if (q8 && q8.kvCacheMiB != null) {
    const pct = (q8.kvCacheMiB / f16.kvCacheMiB) * 100
    t.ok(pct >= 40 && pct <= 65, `q8_0 KV memory ~55% of f16 (actual ${pct.toFixed(0)}%)`)
  }
  if (q4 && q4.kvCacheMiB != null) {
    const pct = (q4.kvCacheMiB / f16.kvCacheMiB) * 100
    t.ok(pct >= 18 && pct <= 40, `q4_0 KV memory ~28% of f16 (actual ${pct.toFixed(0)}%)`)
  }

  // -- Prefill speed: TTFT and prompt-eval t/s --
  // Prompt evaluation (prefill) for quantized KV caches uses a generic
  // path on most backends, while f16 gets fully hardware-fused attention
  // kernels. On a Vulkan/NVIDIA T4, for example, f16 prefill clocks in
  // around 680 t/s while q8_0 is around 40 t/s — not a 30% gap, a ~15x
  // gap. Comparing quant configs to f16 is therefore meaningless.
  //
  // Instead we anchor all quant configs to q8_0 (the closest quant cousin
  // of f16) and only assert that no other quant config is catastrophically
  // slower than q8_0. This catches genuine regressions (e.g. a broken
  // tbq/pq kernel that falls off the fast path entirely) without failing
  // on backend-level prefill asymmetry that is outside the test's scope.
  const prefillRef = byLabel[PREFILL_REFERENCE_LABEL]
  if (!prefillRef) {
    t.comment(`${PREFILL_REFERENCE_LABEL} reference missing; skipping prefill comparisons`)
  } else {
    for (const r of results) {
      const res = r.result
      if (!res || r.cfg.label === 'f16+f16' || r.cfg.label === PREFILL_REFERENCE_LABEL) continue
      if (!res.ttftMs || !prefillRef.ttftMs) continue
      const ceiling = prefillRef.ttftMs * (1 + TTFT_MARGIN)
      t.ok(
        res.ttftMs <= ceiling,
        `${r.cfg.label} TTFT (${res.ttftMs.toFixed(1)} ms) <= ${PREFILL_REFERENCE_LABEL} (${prefillRef.ttftMs.toFixed(1)} ms) + ${Math.round(TTFT_MARGIN * 100)}% margin (${ceiling.toFixed(1)} ms)`
      )

      if (res.promptEvalTps && prefillRef.promptEvalTps) {
        const floor = prefillRef.promptEvalTps * (1 - PROMPT_EVAL_MARGIN)
        t.ok(
          res.promptEvalTps >= floor,
          `${r.cfg.label} prompt eval (${res.promptEvalTps.toFixed(1)} t/s) >= ${PREFILL_REFERENCE_LABEL} (${prefillRef.promptEvalTps.toFixed(1)} t/s) - ${Math.round(PROMPT_EVAL_MARGIN * 100)}% margin (${floor.toFixed(1)} t/s)`
        )
      }
    }
  }

  // -- Decode speed: sanity floor only --
  // Decode is compute-bound (attention matmul + FFN). Quantized KV brings
  // a small read-side saving per token but attention dequant overhead can
  // eat it. On some GPUs (fast fp16 ALUs) f16 can even outpace q4_0 during
  // decode. We therefore only assert that quantized configs are not wildly
  // slower than f16.
  for (const r of results) {
    const res = r.result
    if (!res || r.cfg.label === 'f16+f16') continue
    if (!res.generationTps || !f16.generationTps) continue
    const floor = f16.generationTps * (1 - DECODE_MARGIN)
    t.ok(
      res.generationTps >= floor,
      `${r.cfg.label} decode (${res.generationTps.toFixed(1)} t/s) >= f16 (${f16.generationTps.toFixed(1)} t/s) - ${Math.round(DECODE_MARGIN * 100)}% margin (${floor.toFixed(1)} t/s)`
    )
  }

  // -- TurboQuant vs PolarQuant family comparisons --
  // These are relative checks between tbq/pq variants. They only run when
  // BOTH configs succeeded to avoid spurious failures on backends that
  // support one variant but not the other.
  const pq3 = byLabel['pq3_0+pq3_0']
  const tbq3pq3 = byLabel['tbq3_0+pq3_0']
  const pq4 = byLabel['pq4_0+pq4_0']
  const tbq4pq4 = byLabel['tbq4_0+pq4_0']

  // pq3_0+pq3_0 is the most compact KV (K and V both PolarQuant 3-bit), it
  // MUST be at least as small as tbq3_0+pq3_0 (which packs the K side in
  // a wider turboquant-3 layout) within a small epsilon.
  if (pq3 && tbq3pq3 && pq3.kvCacheMiB != null && tbq3pq3.kvCacheMiB != null) {
    t.ok(
      pq3.kvCacheMiB <= tbq3pq3.kvCacheMiB + MEM_EPSILON_MIB,
      `pq3_0+pq3_0 memory (${pq3.kvCacheMiB.toFixed(2)} MiB) <= tbq3_0+pq3_0 (${tbq3pq3.kvCacheMiB.toFixed(2)} MiB)`
    )
  }
  if (pq4 && tbq4pq4 && pq4.kvCacheMiB != null && tbq4pq4.kvCacheMiB != null) {
    t.ok(
      pq4.kvCacheMiB <= tbq4pq4.kvCacheMiB + MEM_EPSILON_MIB,
      `pq4_0+pq4_0 memory (${pq4.kvCacheMiB.toFixed(2)} MiB) <= tbq4_0+pq4_0 (${tbq4pq4.kvCacheMiB.toFixed(2)} MiB)`
    )
  }

  // -- Bit-width ordering invariants --
  // Within the same quantization family, 3-bit variants must be strictly
  // smaller than the 4-bit ones (pq3 < pq4, tbq3+pq3 < tbq4+pq4). And the
  // Tether PolarQuant 4-bit must beat the standard ggml q4_0 at equal
  // nominal bit-width because pq* uses a tighter block layout.
  const tbq4pq3 = byLabel['tbq4_0+pq3_0']
  if (pq3 && pq4 && pq3.kvCacheMiB != null && pq4.kvCacheMiB != null) {
    t.ok(
      pq3.kvCacheMiB + MEM_EPSILON_MIB < pq4.kvCacheMiB,
      `pq3_0+pq3_0 memory (${pq3.kvCacheMiB.toFixed(2)} MiB) < pq4_0+pq4_0 (${pq4.kvCacheMiB.toFixed(2)} MiB)`
    )
  }
  if (tbq3pq3 && tbq4pq3 && tbq3pq3.kvCacheMiB != null && tbq4pq3.kvCacheMiB != null) {
    // Hold V constant (pq3_0) so the comparison isolates K: tbq3 < tbq4.
    t.ok(
      tbq3pq3.kvCacheMiB + MEM_EPSILON_MIB < tbq4pq3.kvCacheMiB,
      `tbq3_0+pq3_0 memory (${tbq3pq3.kvCacheMiB.toFixed(2)} MiB) < tbq4_0+pq3_0 (${tbq4pq3.kvCacheMiB.toFixed(2)} MiB)`
    )
  }
  if (pq4 && q4 && pq4.kvCacheMiB != null && q4.kvCacheMiB != null) {
    t.ok(
      pq4.kvCacheMiB + MEM_EPSILON_MIB < q4.kvCacheMiB,
      `pq4_0+pq4_0 memory (${pq4.kvCacheMiB.toFixed(2)} MiB) < q4_0+q4_0 (${q4.kvCacheMiB.toFixed(2)} MiB)`
    )
  }

  // pq3_0+pq3_0 should be no slower than tbq3_0+pq3_0 during prefill (less
  // bytes per K element, no tbq -> pq rewrap). Use a wide margin because
  // absolute numbers are small and shared-runner jitter is large.
  const TBQ_VS_PQ_MARGIN = 0.35

  const ckSpeed = (fasterLabel, fasterRes, refLabel, refRes, metric, unit) => {
    const fast = fasterRes && fasterRes[metric]
    const ref = refRes && refRes[metric]
    if (!fast || !ref) return
    const floor = ref * (1 - TBQ_VS_PQ_MARGIN)
    t.ok(
      fast >= floor,
      `${fasterLabel} ${metric} (${fast.toFixed(1)} ${unit}) >= ${refLabel} (${ref.toFixed(1)} ${unit}) - ${Math.round(TBQ_VS_PQ_MARGIN * 100)}% margin`
    )
  }

  // pq* >= tbq*+pq* for prefill and decode (less memory traffic on K side).
  ckSpeed('pq3_0+pq3_0', pq3, 'tbq3_0+pq3_0', tbq3pq3, 'promptEvalTps', 't/s')
  ckSpeed('pq3_0+pq3_0', pq3, 'tbq3_0+pq3_0', tbq3pq3, 'generationTps', 't/s')
  ckSpeed('pq4_0+pq4_0', pq4, 'tbq4_0+pq4_0', tbq4pq4, 'promptEvalTps', 't/s')
  ckSpeed('pq4_0+pq4_0', pq4, 'tbq4_0+pq4_0', tbq4pq4, 'generationTps', 't/s')

  // Bit-width ordering on speed: 3-bit variants move ~25% fewer KV bytes
  // than 4-bit, so prefill should be at least as fast (within margin).
  // Decode is NOT compared across bit-widths because decode is compute-
  // bound, not memory-bound (see top-of-file comment).
  ckSpeed('pq3_0+pq3_0', pq3, 'pq4_0+pq4_0', pq4, 'promptEvalTps', 't/s')
  ckSpeed('tbq3_0+pq3_0', tbq3pq3, 'tbq4_0+pq3_0', tbq4pq3, 'promptEvalTps', 't/s')

  // pq4_0+pq4_0 vs standard q4_0+q4_0: pq* has a tighter block layout and
  // fewer bytes per element, so prefill should be >= q4_0 within margin.
  ckSpeed('pq4_0+pq4_0', pq4, 'q4_0+q4_0', q4, 'promptEvalTps', 't/s')
})
