'use strict'
// QVAC-18298: shared helper for the per-(model x image) VLM perf tests.
// Each gemma4-image-* / qwen3-5-image-* file is a thin entry that calls
// runVlmImagePerf with one image, mirroring the SmolVLM2 image-*.test.js
// structure (one Device Farm test = one image) so a single test stays well
// under the 30-minute mobile cap even on the slower Mali GPU.
//
// This file intentionally does NOT end in `.test.js` so the mobile test
// generator and brittle runner skip it.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')
const { recordPerformance } = require('./_perf-helper.js')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
// Desktop x64-darwin and linux-arm64 hosts have no working GPU stack here so
// they drop to CPU; everywhere else (incl. mobile Device Farm) uses GPU.
const useCpu = isDarwinX64 || isLinuxArm64

// QVAC_PERF_RUNS / QVAC_PERF_WARMUP_RUNS knobs, same as image-*.test.js.
// Default 1 warmup + 1 counted on PRs; the benchmark dispatch bumps RUNS to 3.
function _envInt (key, fallback) {
  let raw = ''
  if (typeof os.getEnv === 'function') raw = os.getEnv(key) || ''
  if (!raw && typeof process !== 'undefined' && process.env) raw = process.env[key] || ''
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const PERF_RUNS = _envInt('QVAC_PERF_RUNS', 1)
const PERF_WARMUP_RUNS = _envInt('QVAC_PERF_WARMUP_RUNS', 1)

// Image cases shared by both models. ctxSize is per-image because Qwen3.5-VL
// uses dense patch tokenization (the 1472x1472 fruit plate → ~4k image
// tokens, the 3000x4000 aurora more), so the large images need a bigger ctx
// to avoid mid-decode overflow. Gemma 4's SigLIP encoder caps at ~1024 image
// tokens, so 4096 is always safe there — gemma uses gemmaCtxSize.
const IMAGE_CASES = {
  elephant: {
    name: 'elephant',
    imageFile: 'elephant.jpg',
    keywords: ['elephant', 'elephants'],
    gemmaCtxSize: '4096',
    qwenCtxSize: '4096'
  },
  'fruit-plate': {
    name: 'fruit plate',
    imageFile: 'fruitPlate.png',
    keywords: ['fruit', 'fruits', 'plate', 'apple', 'banana', 'orange'],
    gemmaCtxSize: '4096',
    qwenCtxSize: '8192'
  },
  'high-res-aurora': {
    name: 'high-res aurora',
    imageFile: 'highRes3000x4000.jpg',
    keywords: ['aurora', 'sky', 'night', 'green', 'light', 'lights'],
    gemmaCtxSize: '4096',
    qwenCtxSize: '8192'
  }
}

const GEMMA4_MODEL = {
  perfLabel: 'gemma4-vl',
  llmModel: {
    modelName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-google_gemma-4-E2B-it-bf16.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/mmproj-google_gemma-4-E2B-it-bf16.gguf'
  },
  // ubatch 320 keeps Gemma 4's Metal compute buffer under the iPhone Jetsam
  // ceiling; reasoning-budget 0 suppresses CoT so a one-sentence answer fits.
  extraConfig: { 'ubatch-size': '320' },
  ctxFor: (imageCase) => imageCase.gemmaCtxSize
}

const QWEN35_MODEL = {
  perfLabel: 'qwen3.5-vl',
  llmModel: {
    modelName: 'Qwen3.5-0.8B-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
  },
  projModel: {
    modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
  },
  extraConfig: {},
  ctxFor: (imageCase) => imageCase.qwenCtxSize
}

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

/**
 * Loads `modelDef`, runs PERF_WARMUP_RUNS warmup + PERF_RUNS counted image
 * inferences on a single `imageCase`, records a perf row per counted run and
 * asserts the expected keyword. One image per call → one Device Farm test.
 */
async function runVlmImagePerf (t, modelDef, imageCase) {
  const [modelName, dirPath] = await ensureModel(modelDef.llmModel)
  const [projModelName] = await ensureModel(modelDef.projModel)
  const modelPath = path.join(dirPath, modelName)
  const projectionModelPath = path.join(dirPath, projModelName)

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: modelDef.ctxFor(imageCase),
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2',
    ...modelDef.extraConfig
  }

  const inference = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: projectionModelPath },
    config,
    logger: createLogger(),
    opts: { stats: true }
  })

  // [image] [model] [backend] so the GitHub summary Test column shows the
  // image under test, matching the existing [elephant] [GPU] image rows.
  const backendTag = useCpu ? 'CPU' : 'GPU'
  const perfLabel = `[${imageCase.name}] [${modelDef.perfLabel}] [${backendTag}]`

  async function runImageInference (imageBytes) {
    const messages = [
      { role: 'user', type: 'media', content: imageBytes },
      { role: 'user', content: 'Describe the image briefly in one sentence.' }
    ]
    const startTime = Date.now()
    const response = await inference.run(messages)
    const chunks = []
    let error = null
    response.onUpdate(data => { chunks.push(data) })
      .onError(err => { error = err })
    await response.await()
    if (error) throw new Error('Inference error: ' + error)
    return {
      output: chunks.join(''),
      totalTime: Date.now() - startTime,
      stats: response.stats || null
    }
  }

  try {
    const t0 = Date.now()
    await inference.load()
    console.log(`  ${perfLabel} model.load() took ${Date.now() - t0} ms`)

    const imageFilePath = getMediaPath(imageCase.imageFile)
    t.ok(fs.existsSync(imageFilePath), `${imageCase.imageFile} image file should exist`)

    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

    for (let w = 1; w <= PERF_WARMUP_RUNS; w++) {
      const warmup = await runImageInference(imageBytes)
      t.comment(`${perfLabel} warmup ${w}/${PERF_WARMUP_RUNS} (${warmup.totalTime}ms, ${warmup.output.length} chars) - perf NOT recorded`)
    }

    let lastOutput = ''
    for (let run = 1; run <= PERF_RUNS; run++) {
      const { output, totalTime, stats } = await runImageInference(imageBytes)
      lastOutput = output
      t.comment(`${perfLabel} run ${run}/${PERF_RUNS} output: "${output.slice(0, 200)}"`)
      t.comment(recordPerformance(perfLabel, totalTime, {
        _output: output,
        stats,
        deviceId: useCpu ? 'cpu' : 'gpu',
        scenario: 'image',
        model: modelName.replace(/\.gguf$/i, '')
      }))
    }

    t.ok(lastOutput.length > 0, `${perfLabel} image inference produced output (${lastOutput.length} chars)`)

    const lowerOutput = lastOutput.toLowerCase()
    const matched = imageCase.keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(lowerOutput))
    t.ok(matched,
      `${perfLabel} output should mention one of ${imageCase.keywords.join(', ')}: "${lastOutput.slice(0, 150)}"`)
  } finally {
    await inference.unload().catch(() => {})
  }
}

module.exports = {
  IMAGE_CASES,
  GEMMA4_MODEL,
  QWEN35_MODEL,
  runVlmImagePerf
}
