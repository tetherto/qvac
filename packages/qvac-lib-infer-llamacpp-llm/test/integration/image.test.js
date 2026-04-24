'use strict'
// test/integration/image.test.js
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { ensureModel, getMediaPath } = require('./utils')
const LlmLlamacpp = require('../../index.js')
const os = require('bare-os')
const process = require('bare-process')

// Dynamic require via path.join prevents bare-pack from statically resolving
// the path during mobile bundling (the script lives outside the addon package).
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  createPerformanceReporter = function (opts) {
    return {
      record () {},
      toJSON () { return { schema_version: '1.0', addon: opts.addon, results: [] } },
      writeReport () {},
      writeStepSummary () {},
      get length () { return 0 }
    }
  }
}

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'
const platformLabel = `${platform}-${arch}`

// NO_GPU=true in CI disables the GPU leg of the matrix (e.g. runners without
// Vulkan/Metal/OpenCL). Both legs run by default on GPU-capable runners so the
// weekly perf-report covers CPU + GPU on every platform that supports it.
const noGpuEnv = (process.env && process.env.NO_GPU) ||
  (typeof os.getEnv === 'function' ? os.getEnv('NO_GPU') : '')
const noGpu = String(noGpuEnv || '').toLowerCase() === 'true'

const _perfReporter = createPerformanceReporter({
  addon: 'llamacpp-llm',
  addonType: 'vision'
})

const _reportPath = path.resolve('.', 'test/results/performance-report.json')

process.on('exit', () => {
  if (_perfReporter.length > 0) {
    _perfReporter.writeReport(_reportPath)
    _perfReporter.writeStepSummary()
    // On iOS/Android the sandboxed fs write above is a no-op. Emit the JSON
    // inline to stdout using [PERF_REPORT_START]...[PERF_REPORT_END] markers
    // so `scripts/perf-report/extract-from-log.js` can reconstruct the
    // artifact from Device Farm console logs. Matches the NMT / OCR pattern.
    if (isMobile && typeof _perfReporter.writeToConsole === 'function') {
      _perfReporter.writeToConsole()
    }
  }
})

// CPU is used for: Intel Macs (DarwinX64), and ARM64 Linux
const useCpu = isDarwinX64 || isLinuxArm64

/**
 * Maps (platform, device) -> canonical backend label used in the perf report.
 * The native addon only reports a coarse CPU/GPU flag, so the specific GPU
 * backend (metal / vulkan / opencl) is derived from the runtime platform.
 *
 * @param {string} device - 'cpu' or 'gpu'
 * @returns {string}
 */
function resolveBackend (device) {
  if (!device || device === 'cpu') return 'cpu'
  if (platform === 'darwin' || platform === 'ios') return 'metal'
  if (platform === 'android') {
    const override = (process.env && process.env.QVAC_GPU_BACKEND) ||
      (typeof os.getEnv === 'function' ? os.getEnv('QVAC_GPU_BACKEND') : '')
    return String(override || 'vulkan').toLowerCase()
  }
  if (platform === 'linux' || platform === 'win32') return 'vulkan'
  return 'gpu'
}

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

// QVAC-17830: VLM perf tests run 1 warmup + N counted iterations per
// (image x backend). Matches OCR's PERF_RUNS=3 convention in
// packages/ocr-onnx/test/integration/doctr-*.test.js so aggregate.js
// produces a meaningful `count=3, mean, std` per cell instead of a
// single unaveraged data point.
//
// Structure differs from OCR intentionally: OCR uses one brittle test()
// per iteration (cheap setup). VLM model load is multi-GB and already
// stresses iOS Device Farm memory; we keep one test() per (image x
// backend) and reuse the loaded LlmLlamacpp instance across all
// iterations. The aggregator groups by `test` label, so N rows with
// the same label still average correctly.
const PERF_RUNS = 3
const PERF_WARMUP_RUNS = 1
// Per-test timeout for the multi-iteration perf tests. Must cover
// (warmup + PERF_RUNS) x one-inference worst case; leave
// TEST_CONSTANTS.timeout unchanged for the other tests in this file.
const PERF_TEST_TIMEOUT = 25 * 60 * 1000 // 25 minutes

/**
 * Device configurations for testing.
 *
 * QVAC-17830 requires CPU + GPU perf coverage on every platform that
 * supports GPU. Runners without GPU set NO_GPU=true so the GPU leg is
 * skipped automatically.
 *
 * Platform support matrix (GPU):
 *   - darwin-arm64         : metal
 *   - darwin-x64           : unsupported (CPU only)
 *   - linux-x64            : vulkan
 *   - linux-arm64          : unsupported today (CPU only)
 *   - win32-x64            : vulkan
 *   - android (any arch)   : vulkan / opencl (runner-dependent)
 *   - ios                  : metal
 */
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

/**
 * Creates model configuration for the specified device
 * @param {string} device - Device type ('cpu' or 'gpu')
 * @returns {Object} Model configuration object
 */
function getConfig (device, modelConfig) {
  return {
    gpu_layers: '98',
    temp: '0.0',
    verbosity: '2',
    device,
    ctx_size: modelConfig.ctx_size
  }
}

/**
 * Sets up a multimodal LlmLlamacpp instance with LLM and projection models
 * @param {Object} t - Test instance
 * @param {string} device - Device to use ('cpu' or 'gpu')
 * @returns {Promise<{inference: LlmLlamacpp}>}
 */
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
    // QVAC-17830: enable runtime stats so VLM perf metrics (TTFT, TPS, token
    // counts, backendDevice) are attached to `response.stats`.
    opts: { stats: true }
  })

  t.teardown(async () => {
    await inference.unload()
  })

  await inference.load()

  return { inference }
}

/**
 * Describes an image using the inference instance
 * @param {LlmLlamacpp} inference - LlmLlamacpp instance
 * @param {string} imageFilePath - Path to the image file
 * @param {string} prompt - Custom prompt for image description
 * @returns {Promise<{generatedText: string, startTime: number, endTime: number}>}
 */
async function describeImage (inference, imageFilePath, prompt = TEST_CONSTANTS.defaultPrompt) {
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: prompt }
  ]

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

/**
 * Runs inference with multiple images and a single text prompt (e.g. "what is in these two images?").
 * @param {LlmLlamacpp} inference - LlmLlamacpp instance
 * @param {string[]} imageFilePaths - Paths to image files (order preserved)
 * @param {string} prompt - Text prompt after the images
 * @returns {Promise<{generatedText: string, startTime: number, endTime: number}>}
 */
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

/**
 * Checks if any of the specified keywords appear in text as whole words
 * @param {string} text - Text to search in
 * @param {string[]} keywords - Array of keywords to search for
 * @returns {Object} Result object with found keywords and match status
 * @returns {string[]} result.foundKeywords - Array of keywords that were found
 * @returns {boolean} result.hasMatch - Whether any keywords were found
 */
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
 * Safely coerces a value to a finite number or returns null.
 * @param {*} v
 * @returns {number|null}
 */
function _num (v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Records VLM performance metrics and returns a human-readable comment.
 *
 * Metric derivation (QVAC-17830):
 *   - prefill_time_ms   = stats.TTFT  (native `t_p_eval_ms` — prompt eval time,
 *                         inclusive of vision encode + image prefill + text prefill)
 *   - decode_time_ms    = total_time_ms - prefill_time_ms  (approximation;
 *                         falls back to generated_tokens / TPS when TTFT absent)
 *   - vision_encode_ms,
 *     image_prefill_ms  = null for now. TODO: expose t_vision_encode_ms /
 *                         t_image_prefill_ms from LlamaModel::runtimeStats so we
 *                         can separate vision pipeline stages.
 *
 * @param {string} label     - Test label (e.g. '[GPU]')
 * @param {number} totalTime - Wall-clock duration in ms
 * @param {Object} [extra]
 * @param {Object|null} [extra.stats]  - response.stats from LlmLlamacpp (when opts.stats:true)
 * @param {string} [extra._output]     - Generated text, recorded as artifact
 * @param {string} [extra.deviceId]    - 'cpu' | 'gpu' (explicit device requested)
 * @returns {string}
 */
function formatPerformanceMetrics (label, totalTime, extra) {
  const stats = (extra && extra.stats) || null
  const totalSeconds = (totalTime / 1000).toFixed(2)

  const ttftMs = stats ? _num(stats.TTFT) : null
  const tps = stats ? _num(stats.TPS) : null
  const generatedTokens = stats ? _num(stats.generatedTokens) : null
  const promptTokens = stats ? _num(stats.promptTokens) : null

  // stats.backendDevice from addon.js is 'cpu'/'gpu' when stats arrive, else undefined.
  const reportedDevice = stats && (stats.backendDevice === 'cpu' || stats.backendDevice === 'gpu')
    ? stats.backendDevice
    : null

  const labelDevice = /\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null
  const effectiveDevice = reportedDevice || (extra && extra.deviceId) || labelDevice
  const backend = resolveBackend(effectiveDevice)

  let decodeMs = null
  if (ttftMs !== null && totalTime > ttftMs) {
    decodeMs = Math.round(totalTime - ttftMs)
  } else if (generatedTokens !== null && tps !== null && tps > 0) {
    decodeMs = Math.round((generatedTokens / tps) * 1000)
  }

  _perfReporter.record(label, {
    backend,
    platform: platformLabel,
    total_time_ms: Math.round(totalTime),
    prefill_time_ms: ttftMs !== null ? Math.round(ttftMs) : null,
    decode_time_ms: decodeMs,
    // TODO(QVAC-17830 follow-up): expose these from native runtimeStats.
    vision_encode_time_ms: null,
    image_prefill_time_ms: null,
    ttft_ms: ttftMs !== null ? Math.round(ttftMs) : null,
    generated_tokens: generatedTokens,
    prompt_tokens: promptTokens,
    tps: tps !== null ? Number(tps.toFixed(2)) : null,
    status: 'ok'
  }, {
    execution_provider: effectiveDevice,
    output: (extra && extra._output) || null
  })

  const lines = [
    `${label} Performance Metrics (backend=${backend}, platform=${platformLabel}):`,
    `    - Total time: ${totalTime}ms (${totalSeconds}s)`,
    `    - Prefill / TTFT: ${ttftMs !== null ? Math.round(ttftMs) + 'ms' : 'n/a'}`,
    `    - Decode: ${decodeMs !== null ? decodeMs + 'ms' : 'n/a'}`,
    `    - TPS: ${tps !== null ? tps.toFixed(2) : 'n/a'}`,
    `    - Tokens: ${generatedTokens !== null ? generatedTokens : 'n/a'} gen / ${promptTokens !== null ? promptTokens : 'n/a'} prompt`
  ]
  return lines.join('\n')
}

/**
 * Image test cases with expected recognition keywords
 * Each test case validates that the model can recognize key elements in the image
 * @typedef {Object} ImageTestCase
 * @property {string} name - Human-readable test case name
 * @property {string} imageFile - Image filename in media directory
 * @property {string[]} keywords - Keywords expected to appear in model output
 * @property {string} keywordType - Description of keyword category for error messages
 */
const imageTestCases = [
  {
    name: 'elephant',
    imageFile: 'elephant.jpg',
    keywords: ['elephant', 'elephants'],
    keywordType: 'elephant-related'
  },
  {
    name: 'fruit plate',
    imageFile: 'fruitPlate.png',
    keywords: ['fruit', 'fruits', 'plate', 'apple', 'apples'],
    keywordType: 'fruit-related'
  },
  {
    name: 'high-res aurora',
    imageFile: 'highRes3000x4000.jpg',
    keywords: ['sky', 'light', 'lights', 'mountain', 'snow', 'aurora'],
    keywordType: 'aurora-sky-related'
  }
]

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

/**
 * QVAC-17830: defines one brittle test() per (image x backend) that
 * loads the model once, then runs PERF_WARMUP_RUNS warmup inferences
 * (not recorded) followed by PERF_RUNS counted inferences (recorded).
 *
 * The perf label is `[${testCase.name}] [${BACKEND}]` so
 * aggregate.js (which groups by `result.test`) sees N rows with the
 * same key and produces `count=PERF_RUNS, mean, std` per cell -- the
 * same shape OCR's doctr-*.test.js produces.
 *
 * Keyword content assertions run once, against the last counted
 * iteration's output, so test correctness still gates the pipeline
 * without bloating the failure surface with N identical checks.
 *
 * @param {ImageTestCase} testCase
 * @param {{id: string, device: string}} deviceConfig
 */
function runImageRecognitionTest (testCase, deviceConfig) {
  const backendTag = deviceConfig.id.toUpperCase()
  const label = `[${testCase.name}] [${backendTag}]`
  const testName = `llama addon can recognize ${testCase.name} in an image [${backendTag}]`

  test(testName, { timeout: PERF_TEST_TIMEOUT }, async t => {
    const { inference } = await setupMultimodalInference(t, deviceConfig.device)

    const imageFilePath = getMediaPath(testCase.imageFile)
    t.ok(fs.existsSync(imageFilePath), `${label} ${testCase.imageFile} image file should exist`)

    // Warmup: primes weight cache / vision projection / GPU command
    // buffers so the counted iterations are not polluted by cold-start
    // cost. Output is logged for traceability but NOT fed to the perf
    // reporter.
    for (let w = 1; w <= PERF_WARMUP_RUNS; w++) {
      const { generatedText, startTime, endTime } =
        await describeImage(inference, imageFilePath, TEST_CONSTANTS.defaultPrompt)
      t.comment(
        `${label} warmup ${w}/${PERF_WARMUP_RUNS} (${endTime - startTime}ms, ` +
        `${generatedText.length} chars) - perf NOT recorded`
      )
    }

    // Counted iterations: each call to formatPerformanceMetrics()
    // appends one row to the perf reporter with the shared `label`.
    let lastGeneratedText = ''
    for (let run = 1; run <= PERF_RUNS; run++) {
      const { generatedText, startTime, endTime, stats } =
        await describeImage(inference, imageFilePath, TEST_CONSTANTS.defaultPrompt)
      const totalTime = endTime - startTime
      lastGeneratedText = generatedText

      t.comment(`${label} run ${run}/${PERF_RUNS} Generated text: ${generatedText}`)
      t.comment(formatPerformanceMetrics(label, totalTime, {
        _output: generatedText,
        stats,
        deviceId: deviceConfig.device
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

for (const testCase of imageTestCases) {
  for (const deviceConfig of DEVICE_CONFIGS) {
    runImageRecognitionTest(testCase, deviceConfig)
  }
}

test('llama addon accepts a file path string as media content', { timeout: TEST_CONSTANTS.timeout }, async t => {
  const deviceConfig = DEVICE_CONFIGS[0]
  const label = `[${deviceConfig.id.toUpperCase()}]`

  const { inference } = await setupMultimodalInference(t, deviceConfig.device)

  const imageFilePath = getMediaPath('elephant.jpg')
  t.ok(fs.existsSync(imageFilePath), `${label} elephant.jpg image file should exist`)

  const generatedText = await describeImageByPath(inference, imageFilePath)
  t.comment(`${label} Generated text: ${generatedText}`)

  t.ok(generatedText.length > 0, `${label} Should generate text output when media content is a file path`)
  const { hasMatch, foundKeywords } = checkKeywordsInText(generatedText, ['elephant', 'elephants'])
  t.ok(hasMatch,
    `${label} Output should describe the elephant when image is passed as a path string. ` +
    `Found keywords: ${foundKeywords.join(', ') || 'none'}. ` +
    `Full output: "${generatedText}"`)
})

// TODO: Fix multi-image for smaller models? Seems like an image per separate message works
// TODO: on smaller models, rather than all images on same message.
// TODO: Discussion at: https://github.com/tetherto/qvac/pull/172#discussion_r2807275659
test('llama addon can handle multiple images in one prompt', { timeout: TEST_CONSTANTS.timeout, skip: true }, async t => {
  const imageFiles = ['elephant.jpg', 'fruitPlate.png']
  const imagePaths = imageFiles.map(f => getMediaPath(f))
  const prompt = 'What is in these two images?'

  for (const deviceConfig of DEVICE_CONFIGS) {
    const label = `[${deviceConfig.id.toUpperCase()}]`

    const { inference } = await setupMultimodalInference(t, deviceConfig.device, LARGE_MULTIMODAL_CONFIG)

    for (const p of imagePaths) {
      t.ok(fs.existsSync(p), `${label} image file should exist: ${p}`)
    }

    const { generatedText, startTime, endTime, stats } = await describeMultipleImages(
      inference,
      imagePaths,
      prompt
    )
    const totalTime = endTime - startTime

    t.comment(`${label} Generated text: ${generatedText}`)
    t.comment(formatPerformanceMetrics(label, totalTime, {
      _output: generatedText,
      stats,
      deviceId: deviceConfig.device
    }))

    t.ok(generatedText.length > 0, `${label} Should generate some text for multiple images`)

    // Expect output to reference both images: at least one elephant-related and one fruit-related
    const elephantKeywords = ['elephant', 'elephants']
    const fruitKeywords = ['fruit', 'fruits', 'plate', 'apple', 'apples']
    const { hasMatch: hasElephant } = checkKeywordsInText(generatedText, elephantKeywords)
    const { hasMatch: hasFruit } = checkKeywordsInText(generatedText, fruitKeywords)

    t.ok(
      hasElephant && hasFruit,
      `${label} Output should mention both images (elephant and fruit). ` +
      `Full output: "${generatedText}"`
    )
  }
})
