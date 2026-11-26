'use strict'

// PrismML's Ternary Bonsai 2.5 27B, a ternary build of Qwen3.8-27B (`qwen35`)
// packed as Q2_0. Its weights are stored in a Hadamard-rotated basis and the
// runtime rotates the activations to match (`prism.hadamard.*` in the GGUF,
// fabric's FWHT kernels). A backend that gets the rotation wrong still loads
// the model and decodes text, so these tests check answers, not just that
// output appears.
//
// The -mtp file is the same model with a draft head. Its speculative-decoding
// behaviour (determinism, stop strings, cache, batching) is a variant in
// speculative-decoding.test.js; here it must answer correctly with drafting
// off and on, and its speed is recorded against plain decoding.
//
// Opt-in with QVAC_RUN_BONSAI_27B=1: about 16 GB of models, desktop-only.
//
// prestage-ignore: Ternary-Bonsai-2.5-27B-Q2_0.gguf — opt-in via QVAC_RUN_BONSAI_27B=1, desktop-only
// prestage-ignore: Ternary-Bonsai-2.5-27B-Q2_0-mtp.gguf — opt-in via QVAC_RUN_BONSAI_27B=1, desktop-only

const path = require('bare-path')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { recordPerformance, coldPrompt } = require('./_perf-helper.js')

const platform = os.platform()
const arch = os.arch()
const isMobile = platform === 'ios' || platform === 'android'

function readEnv(key) {
  if (typeof os.getEnv === 'function') return os.getEnv(key) || ''
  if (typeof process !== 'undefined' && process.env) return process.env[key] || ''
  return ''
}

// CI's CPU-only legs set NO_GPU=true; a GPU arm64 host (DGX Spark) runs CUDA.
const useCpu = (platform === 'darwin' && arch === 'x64') || readEnv('NO_GPU') === 'true'
const device = useCpu ? 'cpu' : 'gpu'

const skip = isMobile
  ? 'Ternary Bonsai 2.5 27B is desktop-only'
  : readEnv('QVAC_RUN_BONSAI_27B') === '1'
    ? false
    : 'Ternary Bonsai 2.5 27B is opt-in; set QVAC_RUN_BONSAI_27B=1'

const MODEL = 'Ternary-Bonsai-2.5-27B-Q2_0.gguf'
const MTP_MODEL = 'Ternary-Bonsai-2.5-27B-Q2_0-mtp.gguf'
const TIMEOUT = 7_200_000

// PrismML's CUDA preset for the -mtp files.
const MTP_CONFIG = {
  'spec-type': 'draft-mtp',
  'spec-draft-n-min': '0',
  'spec-draft-n-max': '3',
  'spec-draft-p-min': '0.1'
}

// The model thinks by default; a zero budget leaves room for the answer.
const NO_THINKING = { reasoning_budget: 0 }

const QUESTIONS = [
  {
    prompt: 'What is 17 multiplied by 23? Reply with only the number.',
    expected: /\b391\b/
  },
  {
    prompt: 'What is the capital of France? Reply with one word.',
    expected: /paris/i
  }
]

// Long enough that decoding usually reaches the token cap; the model may still
// end its answer first.
const PERF_PROMPT = [
  {
    role: 'user',
    content:
      'Write a Python binary search tree class with insert, delete and search methods, ' +
      'each with a docstring.'
  }
]
const PERF_TOKENS = 256

function config(extra = {}) {
  return {
    device,
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '64',
    temp: '0',
    verbosity: '1',
    ...extra
  }
}

async function loadModel(name, cfg) {
  const [file, dir] = await ensureModel({ modelName: name })
  const model = new LlmLlamacpp({
    files: { model: [path.join(dir, file)] },
    config: cfg,
    logger: null,
    opts: { stats: true }
  })
  await model.load()
  return model
}

async function runOnce(model, prompt, generationParams) {
  const start = Date.now()
  const response = await model.run(prompt, { generationParams })
  let output = ''
  await response
    .onUpdate((data) => {
      output += data
    })
    .await()
  return { output, stats: response.stats, totalTime: Date.now() - start }
}

async function assertAnswers(t, model, label) {
  for (const { prompt, expected } of QUESTIONS) {
    const { output } = await runOnce(model, [{ role: 'user', content: prompt }], NO_THINKING)
    t.ok(expected.test(output), `${label}: "${prompt}" -> ${JSON.stringify(output.trim())}`)
  }
}

async function measure(t, model, label, scenario) {
  const run = await runOnce(model, coldPrompt(PERF_PROMPT), {
    ...NO_THINKING,
    predict: PERF_TOKENS
  })
  const { generatedTokens, stopReason } = run.stats
  t.ok(
    generatedTokens > 0 &&
      generatedTokens <= PERF_TOKENS &&
      (stopReason === 'eos' || stopReason === 'predictionLimit'),
    `${label}: generated ${generatedTokens} tokens, stopped on ${stopReason}`
  )
  t.comment(
    recordPerformance(`[${label}] [${device.toUpperCase()}]`, run.totalTime, {
      _output: run.output,
      stats: run.stats,
      deviceId: device,
      scenario,
      model: label
    })
  )
  return run
}

safeTest('Ternary Bonsai 2.5 27B Q2_0 answers correctly', { timeout: TIMEOUT, skip }, async (t) => {
  const model = await loadModel(MODEL, config())
  try {
    await assertAnswers(t, model, 'Q2_0')
    await measure(t, model, 'Bonsai-2.5-27B-Q2_0', 'bonsai')
  } finally {
    await model.unload()
  }
})

safeTest(
  'Ternary Bonsai 2.5 27B MTP file answers correctly with drafting off and on',
  { timeout: TIMEOUT, skip },
  async (t) => {
    let plain
    const withoutDrafting = await loadModel(MTP_MODEL, config())
    try {
      await assertAnswers(t, withoutDrafting, 'Q2_0-mtp, drafting off')
      plain = await measure(t, withoutDrafting, 'Bonsai-2.5-27B-Q2_0-mtp', 'bonsai')
    } finally {
      await withoutDrafting.unload()
    }

    const withDrafting = await loadModel(MTP_MODEL, config(MTP_CONFIG))
    try {
      await assertAnswers(t, withDrafting, 'Q2_0-mtp, drafting on')
      const drafted = await measure(t, withDrafting, 'Bonsai-2.5-27B-Q2_0-mtp+MTP', 'bonsai-mtp')
      const { draftTokens, draftAcceptedTokens } = drafted.stats
      t.ok(draftTokens > 0, `drafted ${draftTokens} tokens`)
      t.ok(
        draftAcceptedTokens > 0 && draftAcceptedTokens <= draftTokens,
        `accepted ${draftAcceptedTokens} of ${draftTokens}`
      )
      const rate = ((100 * draftAcceptedTokens) / draftTokens).toFixed(1)
      const tps = (stats) => stats.TPS.toFixed(1)
      const speedup = (drafted.stats.TPS / plain.stats.TPS).toFixed(2)
      t.comment(
        `MTP: ${rate}% of drafts accepted; decode ${tps(drafted.stats)} vs ` +
          `${tps(plain.stats)} tokens/s (${speedup}x)`
      )
    } finally {
      await withDrafting.unload()
    }
  }
)
