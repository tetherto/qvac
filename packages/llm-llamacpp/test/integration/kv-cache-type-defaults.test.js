'use strict'

// KV-cache-type default tests (QVAC-21318).
//
// Verifies the auto-default behaviour added to LlamaModel::tuneConfigMap():
//   - On a Metal/Vulkan GPU, when the caller does not set cache-type-k/v, the
//     addon defaults both to q8_0 (quality-neutral vs f16 on GPU, ~47% KV cut).
//   - On CPU (or when device:gpu falls back to CPU), the default is left
//     untouched (llama.cpp uses f16) — ARM q8_0 has a quality/throughput cost.
//   - On OpenCL (Adreno), the default also stays f16 — quantized KV-cache shifts
//     abort on Adreno, so quantized KV is REJECTED there (q8_0 and q4_0 alike).
//   - An explicit user cache type is respected over the default on CPU/Vulkan/
//     Metal; on OpenCL an explicit quantized type is rejected with a clear error.
//
// The effective cache type is not exposed to JS, so these tests assert on the
// `llama_kv_cache: ... K (<type>): ... V (<type>): ...` line emitted by native
// llama.cpp (captured via attachSpecLogger), the same approach used by
// quantized-kvcache.test.js. The active backend is likewise inferred from the
// logs so the expected default adapts to whatever GPU (if any) the CI runner has.
//
// These use `safeTest` (not bare `test`) so a model load/run throw surfaces as a
// soft test failure with context instead of aborting the whole integration run.

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')

// Small, CI-downloaded model (head_dim 64). q8_0/q4_0 KV are broadly supported,
// so this keeps the test cheap and deterministic.
const MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful, respectful and honest assistant.' },
  { role: 'user', content: 'Explain what a neural network is in two sentences.' }
]

// Return { k, v } from the most recent `llama_kv_cache:` line, or null if no
// such line was logged. Scans from the end so we read the current run's line,
// not a previous test's.
function parseKvCacheTypes (logs) {
  const lineRe = /llama_kv_cache:/
  const kRe = /K\s*\(([^)]+)\)/
  const vRe = /V\s*\(([^)]+)\)/
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i]
    if (!lineRe.test(line)) continue
    const k = line.match(kRe)
    const v = line.match(vRe)
    if (k && v) return { k: k[1].trim(), v: v[1].trim() }
  }
  return null
}

// The q8_0 default applies only on a real Metal/Vulkan GPU. The addon emits this
// exact INFO line (captured via the logger) only when it actually applies the
// default — i.e. a real Metal/Vulkan GPU was selected. It is absent on CPU, on a
// device:gpu run that fell back to CPU, and on OpenCL/Adreno (excluded because
// quantized KV-cache shifts abort there). Using the addon's own decision log is
// robust: raw llama.cpp signals like "no usable GPU found" are NOT routed through
// the logger, so they cannot be relied on here.
function expectedGpuDefault (logText) {
  return /defaulting kv-cache to q8_0/i.test(logText) ? 'q8_0' : 'f16'
}

async function loadWithConfig (extraConfig) {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const model = new LlmLlamacpp({
    files: { model: [path.join(dirPath, modelName)] },
    config: {
      gpu_layers: '999',
      ctx_size: '2048',
      n_predict: '32',
      temp: '0.7',
      seed: '42',
      verbosity: '2',
      // Set flash attention explicitly — the q8_0 auto-default requires it, and
      // we don't want the test to depend on tuneConfigMap()'s FA-default order.
      'flash-attn': 'on',
      ...extraConfig
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
    const kvTypes = parseKvCacheTypes(specLogger.logs)
    const logText = specLogger.logs.join('\n')
    return { output, kvTypes, logText }
  } finally {
    await model.unload().catch(() => {})
    specLogger.release()
  }
}

safeTest('GPU defaults KV-cache to q8_0 (Metal/Vulkan) when unset', { timeout: 900_000 }, async t => {
  // device=gpu, no cache-type-k/v (flash-attn set on in loadWithConfig). The
  // expected default adapts to the backend the runner actually selected.
  const { output, kvTypes, logText } = await loadWithConfig({ device: 'gpu' })
  const expected = expectedGpuDefault(logText)

  t.ok(output.length > 0, 'GPU run produced output')
  t.ok(kvTypes, 'KV-cache allocation line was logged')
  t.is(kvTypes.k, expected, `cache-type-k default matches backend policy (${expected})`)
  t.is(kvTypes.v, expected, `cache-type-v default matches backend policy (${expected})`)
})

safeTest('CPU keeps KV-cache at f16 when unset', { timeout: 900_000 }, async t => {
  // device=cpu, no cache-type-k/v. The auto-default must not apply on CPU.
  const { output, kvTypes } = await loadWithConfig({ device: 'cpu' })

  t.ok(output.length > 0, 'CPU run produced output')
  t.ok(kvTypes, 'KV-cache allocation line was logged')
  t.is(kvTypes.k, 'f16', 'cache-type-k stays f16 on CPU')
  t.is(kvTypes.v, 'f16', 'cache-type-v stays f16 on CPU')
})

safeTest('GPU respects an explicit cache type over the default', { timeout: 900_000 }, async t => {
  // QVAC-21318: explicit q4_0 is honoured verbatim on CPU / Vulkan / Metal. On
  // OpenCL (Adreno) quantized KV is now REJECTED (it aborts on a KV-cache shift),
  // so load() throws a clear StatusError instead — accept whichever applies to
  // the backend the CI runner selected.
  let result
  try {
    result = await loadWithConfig({
      device: 'gpu',
      'cache-type-k': 'q4_0',
      'cache-type-v': 'q4_0'
    })
  } catch (err) {
    const msg = err?.message || String(err)
    t.ok(
      /opencl/i.test(msg) && /quantized|not supported/i.test(msg),
      `quantized KV rejected on OpenCL with a clear error: "${msg.slice(0, 160)}"`
    )
    return
  }

  const { output, kvTypes } = result
  t.ok(output.length > 0, 'GPU run produced output')
  t.ok(kvTypes, 'KV-cache allocation line was logged')
  t.is(kvTypes.k, 'q4_0', 'user cache-type-k respected (not defaulted to q8_0)')
  t.is(kvTypes.v, 'q4_0', 'user cache-type-v respected (not defaulted to q8_0)')
})
