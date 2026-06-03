'use strict'
// QVAC-18298: Qwen3.5-VL image-inference perf rows for the weekly
// perf-report aggregate. Split into its own file (separate from the
// functional qwen3-5.test.js) so the mobile generator gives it a dedicated
// runQwen35ImagePerfTest function that runs in an isolated Device Farm
// group — the functional qwen3-5 suite was already near the 30-minute
// per-test cap on slower Mali GPUs, so bundling the 3-image perf loop in
// the same group timed out.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')
const os = require('bare-os')
const process = require('bare-process')
const { recordPerformance } = require('./_perf-helper.js')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

function _envInt (key, fallback) {
  let raw = ''
  if (typeof os.getEnv === 'function') raw = os.getEnv(key) || ''
  if (!raw && typeof process !== 'undefined' && process.env) raw = process.env[key] || ''
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const PERF_RUNS = _envInt('QVAC_PERF_RUNS', 1)
const PERF_WARMUP_RUNS = _envInt('QVAC_PERF_WARMUP_RUNS', 1)

const QWEN3_5_MODEL = {
  name: 'Qwen3.5-0.8B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

const QWEN3_5_PROJ_MODEL = {
  name: 'mmproj-Qwen3.5-0.8B-F16.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
}

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

// VLM perf coverage matches the SmolVLM2 image-*.test.js set. Qwen3.5-VL
// uses dense patch tokenization, so the 1472x1472 fruit plate encodes to
// ~4k image tokens and the high-res aurora more — a fixed 4096 ctx would
// overflow mid-decode. elephant (~270 tokens) keeps a small ctx; the large
// images get 8192 headroom for image tokens + generation.
const QWEN35_IMAGE_CASES = [
  { name: 'elephant', imageFile: 'elephant.jpg', keywords: ['elephant', 'elephants'], ctxSize: '4096' },
  { name: 'fruit plate', imageFile: 'fruitPlate.png', keywords: ['fruit', 'fruits', 'plate', 'apple', 'banana', 'orange'], ctxSize: '8192' },
  { name: 'high-res aurora', imageFile: 'highRes3000x4000.jpg', keywords: ['aurora', 'sky', 'night', 'green', 'light', 'lights'], ctxSize: '8192' }
]

async function runQwen35ImagePerf (t, imageCase) {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const [projModelName] = await ensureModel({
    modelName: QWEN3_5_PROJ_MODEL.name,
    downloadUrl: QWEN3_5_PROJ_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)
  const projectionModelPath = path.join(dirPath, projModelName)

  // reasoning-budget 0 suppresses Qwen3.5's <think> trace so a one-sentence
  // image answer doesn't eat the ctx budget; ctx_size is per-image so large
  // images don't overflow mid-decode.
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: imageCase.ctxSize,
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2'
  }

  const inference = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: projectionModelPath },
    config,
    logger: createLogger(),
    opts: { stats: true }
  })

  // [image] [model] [backend] so the GitHub summary Test column shows the
  // image under test, matching the [elephant] [GPU] image rows.
  const backendTag = useCpu ? 'CPU' : 'GPU'
  const perfLabel = `[${imageCase.name}] [qwen3.5-vl] [${backendTag}]`

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

for (const imageCase of QWEN35_IMAGE_CASES) {
  test(`Qwen3.5-VL image perf [${imageCase.name}]`, {
    timeout: 1_800_000
  }, async t => {
    await runQwen35ImagePerf(t, imageCase)
  })
}

setImmediate(() => {
  setTimeout(() => {}, 500)
})
