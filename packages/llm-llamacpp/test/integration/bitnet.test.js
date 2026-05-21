'use strict'

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const { recordPerformance } = require('./_perf-helper.js')

const os = require('bare-os')
const isAndroid = os.platform() === 'android'

const BITNET_MODEL = {
  name: 'bitnet_b1_58-large-TQ2_0.gguf',
  url: 'https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0/resolve/main/bitnet_b1_58-large-TQ2_0.gguf'
}

const PROMPT = [
  { role: 'user', content: 'What is 2 + 2?' }
]

// QVAC-17830: 1 warmup + 1 counted iteration on PR runs, configurable
// via QVAC_PERF_RUNS / QVAC_PERF_WARMUP_RUNS for the dedicated
// benchmark workflow_dispatch (QVAC-18111). BitNet on Android Device
// Farm is heavy enough that a single counted run already gives a
// representative TTFT / TPS on PRs; the benchmark workflow can crank
// it up if we want mean ± std numbers.
// Scenario tag = 'bitnet' so the aggregator puts the row under the
// bitnet section in the squashed summary.
//
// Read env via bare-os — Bare doesn't define `process` as a global
// at module-init time, so referencing `process.env` here would throw
// `ReferenceError: process is not defined`. Fall back to
// `process.env` only via a `typeof` guard for Node code paths.
function _envInt (key, fallback) {
  let raw = ''
  if (typeof os.getEnv === 'function') raw = os.getEnv(key) || ''
  if (!raw && typeof process !== 'undefined' && process.env) raw = process.env[key] || ''
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const PERF_RUNS = _envInt('QVAC_PERF_RUNS', 1)
const PERF_WARMUP_RUNS = _envInt('QVAC_PERF_WARMUP_RUNS', 1)
const PERF_LABEL = '[bitnet] [GPU]'

async function runBitnetInference (addon, prompt) {
  const startTime = Date.now()
  const response = await addon.run(prompt)
  const chunks = []
  let error = null
  response
    .onUpdate(data => { chunks.push(data) })
    .onError(err => { error = err })
  await response.await()
  if (error) throw new Error('bitnet inference failed: ' + error)
  return {
    output: chunks.join('').trim(),
    startTime,
    endTime: Date.now(),
    stats: response.stats || null
  }
}

safeTest('bitnet model can run simple inference', { timeout: 900_000, skip: !isAndroid }, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: BITNET_MODEL.name,
    downloadUrl: BITNET_MODEL.url
  })

  const modelPath = path.join(dirPath, modelName)
  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const config = {
    gpu_layers: '999',
    ctx_size: '1024',
    device: 'gpu',
    n_predict: '32',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  try {
    await addon.load()

    for (let w = 1; w <= PERF_WARMUP_RUNS; w++) {
      const { output, startTime, endTime } = await runBitnetInference(addon, PROMPT)
      t.comment(
        `${PERF_LABEL} warmup ${w}/${PERF_WARMUP_RUNS} ` +
        `(${endTime - startTime}ms, ${output.length} chars) - perf NOT recorded`
      )
    }

    let lastOutput = ''
    for (let run = 1; run <= PERF_RUNS; run++) {
      const { output, startTime, endTime, stats } = await runBitnetInference(addon, PROMPT)
      lastOutput = output
      const totalTime = endTime - startTime
      t.comment(`${PERF_LABEL} run ${run}/${PERF_RUNS} BitNet output: "${output}"`)
      t.comment(recordPerformance(PERF_LABEL, totalTime, {
        _output: output,
        stats,
        deviceId: 'gpu',
        scenario: 'bitnet',
        model: BITNET_MODEL.name.replace(/\.gguf$/i, '')
      }))
    }

    t.ok(lastOutput.length > 0, 'bitnet model should generate output')
  } finally {
    await addon.unload().catch(() => { })
    specLogger.release()
  }
})
