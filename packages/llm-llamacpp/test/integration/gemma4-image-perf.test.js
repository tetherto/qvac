'use strict'
// QVAC-18298: Gemma4-VL image-inference perf rows for the weekly
// perf-report aggregate. Split into its own file (separate from the
// functional gemma4.test.js) so the mobile generator gives it a dedicated
// runGemma4ImagePerfTest function that runs in an isolated Device Farm
// group — the functional gemma4 suite (text / multi-turn / tool calling /
// reasoning) was already near the 30-minute per-test cap on slower Mali
// GPUs, so bundling the 3-image perf loop in the same group timed out.

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

// Same QVAC_PERF_RUNS / QVAC_PERF_WARMUP_RUNS knobs as the image-*.test.js
// rows. Default 1+1 on PRs; benchmark dispatch bumps to 3.
function _envInt (key, fallback) {
  let raw = ''
  if (typeof os.getEnv === 'function') raw = os.getEnv(key) || ''
  if (!raw && typeof process !== 'undefined' && process.env) raw = process.env[key] || ''
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const PERF_RUNS = _envInt('QVAC_PERF_RUNS', 1)
const PERF_WARMUP_RUNS = _envInt('QVAC_PERF_WARMUP_RUNS', 1)

const GEMMA4_MODEL = {
  llmModel: {
    modelName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-google_gemma-4-E2B-it-bf16.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/mmproj-google_gemma-4-E2B-it-bf16.gguf'
  }
}

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

// VLM perf coverage matches the SmolVLM2 image-*.test.js set (elephant /
// fruit plate / high-res aurora) so a Phase-3 optimization that only
// regresses large or high-resolution inputs is still caught. Gemma 4's
// SigLIP encoder caps at ~1024 image tokens regardless of resolution, so
// 4096 ctx never overflows for any image here.
const GEMMA4_IMAGE_CASES = [
  { name: 'elephant', imageFile: 'elephant.jpg', keywords: ['elephant', 'elephants'], ctxSize: '4096' },
  { name: 'fruit plate', imageFile: 'fruitPlate.png', keywords: ['fruit', 'fruits', 'plate', 'apple', 'banana', 'orange'], ctxSize: '4096' },
  { name: 'high-res aurora', imageFile: 'highRes3000x4000.jpg', keywords: ['aurora', 'sky', 'night', 'green', 'light', 'lights'], ctxSize: '4096' }
]

async function runGemma4ImagePerf (t, imageCase) {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
  const [projModelName] = await ensureModel(GEMMA4_MODEL.projModel)
  const modelPath = path.join(dirPath, modelName)
  const projectionModelPath = path.join(dirPath, projModelName)

  // ubatch 320 / reasoning-budget 0 keep Gemma 4's compute buffer + KV cache
  // under the iPhone Jetsam ceiling while still fitting the image tokens.
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: imageCase.ctxSize,
    'ubatch-size': '320',
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
  const perfLabel = `[${imageCase.name}] [gemma4-vl] [${backendTag}]`

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

for (const imageCase of GEMMA4_IMAGE_CASES) {
  test(`Gemma4-VL image perf [${imageCase.name}]`, {
    timeout: 1_800_000
  }, async t => {
    await runGemma4ImagePerf(t, imageCase)
  })
}

setImmediate(() => {
  setTimeout(() => {}, 500)
})
