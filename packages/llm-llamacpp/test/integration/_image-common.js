'use strict'
// QVAC-17830: shared helpers for the per-image VLM integration tests
// (image-elephant, image-fruit-plate, image-high-res-aurora). This file
// intentionally does NOT end in `.test.js` so it is not picked up by the
// mobile test generator or the brittle test runner.
//
// Why split per image:
//   - iOS Device Farm memorystatus/Jetsam kills the bare process when a
//     single run loads the VLM multiple times. Running each image in its
//     own Device Farm group = one bare process per image = much smaller
//     peak memory footprint and crash isolation.
//   - Per-test flushing of the perf reporter means even if one group
//     still crashes mid-run, the data from earlier iterations of that
//     image is already in the logcat / syslog stream.
//
// Perf wiring (singleton reporter, mobile fallback, recordPerformance,
// resolveBackend, platform constants) lives in `_perf-helper.js` so
// the bitnet / tool-calling / future text-only LLM tests can share it
// without dragging the image-specific helpers in.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const os = require('bare-os')
const { ensureModel, getMediaPath } = require('./utils')
const LlmLlamacpp = require('../../index.js')
const {
  platform,
  arch,
  platformLabel,
  isDarwinX64,
  isLinuxArm64,
  isMobile,
  resolveBackend,
  recordPerformance
} = require('./_perf-helper.js')

// Bare doesn't define `process` as a global at module-init time, so
// guard the Node-style fallback with `typeof process !== 'undefined'`.
const noGpuEnv = (typeof os.getEnv === 'function' ? os.getEnv('NO_GPU') : '') ||
  (typeof process !== 'undefined' && process.env ? process.env.NO_GPU : '')
const noGpu = String(noGpuEnv || '').toLowerCase() === 'true'

// CPU-only platforms (no GPU inference path today)
const useCpu = isDarwinX64 || isLinuxArm64

const MULTIMODAL_MODEL_CONFIG = {
  llmModel: {
    modelName: 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  },
  projModel: {
    modelName: 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  },
  ctx_size: '2048'
}

const LARGE_MULTIMODAL_CONFIG = {
  llmModel: {
    modelName: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/Qwen3VL-2B-Instruct-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'
  },
  ctx_size: '7046'
}

const TEST_CONSTANTS = {
  timeout: 900_000, // 15 minutes
  maxWaitSeconds: 1000,
  defaultPrompt: 'Describe the image briefly in one sentence.'
}

// QVAC-17830: 1 warmup + N counted iterations per (image x backend).
//
// Per the policy agreed on Slack with @Olya / @Gianfranco (2026-04-30):
// PR runs default to 1 warmup + 1 counted (n=1, no averaging) so we
// don't pay the full perf cost on every PR. The dedicated
// "Benchmark Performance (LLM)" workflow_dispatch (QVAC-18111) is the
// only place we crank these up to produce mean ± std numbers.
//
// Override via env when running the benchmark workflow:
//   QVAC_PERF_RUNS=3        QVAC_PERF_WARMUP_RUNS=1
//
// Read env via bare-os (Bare doesn't define `process` as a global at
// module-init time), with a guarded `process.env` fallback for
// Node code paths that import this file.
function _envInt (key, fallback) {
  let raw = ''
  if (typeof os.getEnv === 'function') raw = os.getEnv(key) || ''
  if (!raw && typeof process !== 'undefined' && process.env) raw = process.env[key] || ''
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const PERF_RUNS = _envInt('QVAC_PERF_RUNS', 1)
const PERF_WARMUP_RUNS = _envInt('QVAC_PERF_WARMUP_RUNS', 1)
const PERF_TEST_TIMEOUT = 25 * 60 * 1000 // 25 minutes

const ALL_DEVICE_CONFIGS = [
  { id: 'cpu', device: 'cpu' },
  { id: 'gpu', device: 'gpu' }
]

const gpuSupported = !useCpu && (
  isMobile ||
  (platform === 'darwin' && arch === 'arm64') ||
  (platform === 'linux' && arch === 'x64') ||
  (platform === 'win32' && arch === 'x64')
)

const DEVICE_CONFIGS = ALL_DEVICE_CONFIGS.filter(c => {
  if (c.id === 'cpu') return true
  return gpuSupported && !noGpu
})

function getConfig (device, modelConfig) {
  return {
    gpu_layers: '98',
    temp: '0.0',
    verbosity: '2',
    device,
    ctx_size: modelConfig.ctx_size
  }
}

async function setupMultimodalInference (t, device = 'gpu', modelConfig = MULTIMODAL_MODEL_CONFIG) {
  const [modelName, dirPath] = await ensureModel(modelConfig.llmModel)
  t.ok(fs.existsSync(path.join(dirPath, modelName)), 'LLM model file should exist')

  const [projModelName] = await ensureModel(modelConfig.projModel)
  t.ok(fs.existsSync(path.join(dirPath, projModelName)), 'Projection model file should exist')

  const modelPath = path.join(dirPath, modelName)
  const inference = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: path.join(dirPath, projModelName) },
    config: getConfig(device, modelConfig),
    logger: console,
    opts: { stats: true }
  })

  t.teardown(async () => {
    await inference.unload()
  })

  await inference.load()

  // Follow-up to QVAC-17830: surface the loaded model id so perf rows
  // can label which weights produced the numbers. Strip the .gguf
  // extension so the rendered Model column reads e.g.
  // "SmolVLM2-500M-Video-Instruct-Q8_0" instead of full filename noise.
  return { inference, modelName: modelName.replace(/\.gguf$/i, '') }
}

async function describeImage (inference, imageFilePath, prompt = TEST_CONSTANTS.defaultPrompt, runOptions = undefined) {
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: prompt }
  ]

  const startTime = Date.now()
  // QVAC-19118 (A2): optional runOptions lets cache-perf tests pass a
  // { cacheKey, saveCacheToDisk } so a repeated prompt reuses the KV
  // prefix (KV-cache hit). Defaults to undefined → identical to the
  // previous stateless `inference.run(messages)` call for every other
  // caller.
  const response = await inference.run(messages, runOptions)
  const generatedText = []
  let error = null

  response.onUpdate(data => {
    generatedText.push(data)
  }).onError(err => {
    error = err
  })

  await response.await()

  if (error) {
    throw new Error('Inference error: ' + error)
  }

  return {
    generatedText: generatedText.join(''),
    startTime,
    endTime: Date.now(),
    stats: response.stats || null
  }
}

async function describeMultipleImages (inference, imageFilePaths, prompt) {
  const messages = [
    { role: 'system', content: 'You are a helpful, respectful and honest assistant.' }
  ]
  for (const imageFilePath of imageFilePaths) {
    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))
    messages.push({ role: 'user', type: 'media', content: imageBytes })
  }
  messages.push({ role: 'user', content: prompt })

  const startTime = Date.now()
  const response = await inference.run(messages)
  const generatedText = []
  let error = null

  response.onUpdate(data => {
    generatedText.push(data)
  }).onError(err => {
    error = err
  })

  await response.await()

  if (error) {
    throw new Error('Inference error: ' + error)
  }

  return {
    generatedText: generatedText.join(''),
    startTime,
    endTime: Date.now(),
    stats: response.stats || null
  }
}

async function describeImageByPath (inference, imageFilePath, prompt = TEST_CONSTANTS.defaultPrompt) {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: imageFilePath },
    { role: 'user', content: prompt }
  ]

  const response = await inference.run(messages)
  const generatedText = []
  let error = null

  response.onUpdate(data => {
    generatedText.push(data)
  }).onError(err => {
    error = err
  })

  await response.await()

  if (error) {
    throw new Error('Inference error: ' + error)
  }

  return generatedText.join('')
}

function checkKeywordsInText (text, keywords) {
  const foundKeywords = keywords.filter(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i')
    return regex.test(text)
  })

  return {
    foundKeywords,
    hasMatch: foundKeywords.length > 0
  }
}

/**
 * Defines one brittle test() per (image x backend). Loads the model
 * once per test(), runs PERF_WARMUP_RUNS warmup inferences (not
 * recorded), then PERF_RUNS counted inferences. Keyword assertions
 * run once against the last counted iteration's output.
 *
 * The perf label is `[${testCase.name}] [${BACKEND}]` so aggregate.js
 * (which groups by result.test) produces `count=PERF_RUNS, mean, std`
 * per cell — same shape OCR's doctr-*.test.js produces.
 */
function runImageRecognitionTest (testCase, deviceConfig) {
  const backendTag = deviceConfig.id.toUpperCase()
  const label = `[${testCase.name}] [${backendTag}]`
  const testName = `llama addon can recognize ${testCase.name} in an image [${backendTag}]`

  test(testName, { timeout: PERF_TEST_TIMEOUT }, async t => {
    const { inference, modelName } = await setupMultimodalInference(t, deviceConfig.device)

    const imageFilePath = getMediaPath(testCase.imageFile)
    t.ok(fs.existsSync(imageFilePath), `${label} ${testCase.imageFile} image file should exist`)

    // QVAC-17830: iOS-only small-image pre-warmup. On Device Farm iPhones
    // the fruit-plate 10 MB PNG crashes the app during the very first
    // vision_encode before any perf record() fires — Metal shaders get
    // JIT-compiled, the KV cache grows, and the image-prefill buffer
    // allocates all in one shot. Running a cheap inference first on a
    // tiny image (e.g. elephant.jpg ~23 KB) pays those one-shot costs
    // ahead of time so the real image's first pass only needs the
    // incremental delta. Guarded by testCase.iosWarmupImage so it only
    // fires for the tests that actually opt in (fruit plate today),
    // and only on iOS so desktop/Android timings are untouched. When
    // this pre-warmup successfully runs we treat it AS the test's
    // warmup pass and skip the standard PERF_WARMUP_RUNS loop below
    // — the whole point is to keep the iOS cold-path inference count
    // as low as possible (1 small + 1 real instead of 1 small + 1 +
    // counted), so a heavy image like fruit-plate stays under the
    // ~3.3 GB Jetsam ceiling.
    let iosPreWarmupRan = false
    if (platform === 'ios' && testCase.iosWarmupImage) {
      try {
        const warmupPath = getMediaPath(testCase.iosWarmupImage)
        if (fs.existsSync(warmupPath)) {
          t.comment(
            `${label} iOS pre-warmup with ${testCase.iosWarmupImage} ` +
            '(perf NOT recorded)'
          )
          const w = await describeImage(inference, warmupPath, TEST_CONSTANTS.defaultPrompt)
          t.comment(
            `${label} iOS pre-warmup done in ${w.endTime - w.startTime}ms ` +
            `(${w.generatedText.length} chars)`
          )
          iosPreWarmupRan = true
        } else {
          t.comment(
            `${label} iOS pre-warmup image not found at ${warmupPath} ` +
            '— skipping pre-warmup'
          )
        }
      } catch (err) {
        t.comment(`${label} iOS pre-warmup failed (non-fatal): ${err.message}`)
      }
    }

    if (!iosPreWarmupRan) {
      for (let w = 1; w <= PERF_WARMUP_RUNS; w++) {
        const { generatedText, startTime, endTime } =
          await describeImage(inference, imageFilePath, TEST_CONSTANTS.defaultPrompt)
        t.comment(
          `${label} warmup ${w}/${PERF_WARMUP_RUNS} (${endTime - startTime}ms, ` +
          `${generatedText.length} chars) - perf NOT recorded`
        )
      }
    } else {
      t.comment(
        `${label} skipping standard warmup — iOS pre-warmup with ` +
        `${testCase.iosWarmupImage} already exercised the multimodal pipeline`
      )
    }

    // QVAC-17830: iOS-only per-test counted-iteration override. PR runs
    // default to PERF_RUNS=1; the benchmark workflow_dispatch
    // (QVAC-18111) bumps this to 3 (or more) via QVAC_PERF_RUNS. The
    // iPhone Device Farm nodes have a hard ~3.3 GB per-app Jetsam
    // ceiling, and a heavy image like the 10 MB fruit-plate PNG + VLM
    // model + KV cache growth blows that under the benchmark workflow's
    // n=3 plan even WITH the elephant pre-warmup. Opting an image into
    // iosPerfRuns=1 caps that image at exactly 2 inferences on iOS
    // (1 small pre-warmup + 1 counted real image) regardless of
    // QVAC_PERF_RUNS, so the benchmark workflow doesn't OOM iPhone.
    // Desktop + Android always honour PERF_RUNS; on PR runs (default
    // PERF_RUNS=1) the override is a no-op.
    const countedRuns = (platform === 'ios' && Number.isFinite(testCase.iosPerfRuns))
      ? testCase.iosPerfRuns
      : PERF_RUNS

    let lastGeneratedText = ''
    for (let run = 1; run <= countedRuns; run++) {
      const { generatedText, startTime, endTime, stats } =
        await describeImage(inference, imageFilePath, TEST_CONSTANTS.defaultPrompt)
      const totalTime = endTime - startTime
      lastGeneratedText = generatedText

      t.comment(`${label} run ${run}/${countedRuns} Generated text: ${generatedText}`)
      t.comment(recordPerformance(label, totalTime, {
        _output: generatedText,
        stats,
        deviceId: deviceConfig.device,
        scenario: 'image',
        model: modelName
      }))
    }

    t.ok(lastGeneratedText.length > 0, `${label} Should generate some text output for the image`)
    const { foundKeywords, hasMatch } = checkKeywordsInText(lastGeneratedText, testCase.keywords)
    t.ok(hasMatch,
      `${label} Output should contain at least one ${testCase.keywordType} word as a whole word. ` +
      `Found keywords: ${foundKeywords.join(', ') || 'none'}. ` +
      `Full output: "${lastGeneratedText}"`)
  })
}

/**
 * Runs `runImageRecognitionTest` for one image across every
 * configured backend (CPU + GPU on GPU-capable platforms, CPU only
 * on the rest). Used by the image-<name>.test.js entry points.
 */
function runPerImageBackendTests (testCase) {
  for (const deviceConfig of DEVICE_CONFIGS) {
    runImageRecognitionTest(testCase, deviceConfig)
  }
}

module.exports = {
  DEVICE_CONFIGS,
  LARGE_MULTIMODAL_CONFIG,
  MULTIMODAL_MODEL_CONFIG,
  PERF_RUNS,
  PERF_TEST_TIMEOUT,
  PERF_WARMUP_RUNS,
  TEST_CONSTANTS,
  checkKeywordsInText,
  describeImage,
  describeImageByPath,
  describeMultipleImages,
  isMobile,
  platform,
  platformLabel,
  recordPerformance,
  resolveBackend,
  runImageRecognitionTest,
  runPerImageBackendTests,
  setupMultimodalInference
}
