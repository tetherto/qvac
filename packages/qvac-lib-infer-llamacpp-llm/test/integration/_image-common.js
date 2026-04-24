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

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const { ensureModel, getMediaPath } = require('./utils')
const LlmLlamacpp = require('../../index.js')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'
const platformLabel = `${platform}-${arch}`

const noGpuEnv = (process.env && process.env.NO_GPU) ||
  (typeof os.getEnv === 'function' ? os.getEnv('NO_GPU') : '')
const noGpu = String(noGpuEnv || '').toLowerCase() === 'true'

// Dynamic require via path.join prevents bare-pack from statically resolving
// the path during mobile bundling (the script lives outside the addon
// package). Desktop: loads the full reporter. Mobile: falls through to the
// inline fallback below, which MIRRORS OCR's implementation — it records
// in-memory, writes JSON to any writable dir, and emits the
// [PERF_REPORT_START]...[PERF_REPORT_END] markers to console (with logcat
// chunking when payload exceeds ~800 chars) so
// scripts/perf-report/extract-from-log.js can reconstruct the artifact
// from Device Farm logs.
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  // Hard cap on how much of the model's text output we keep in-memory
  // per record on mobile. The per-test flush (writeReport + console
  // emit) stringifies the cumulative results; unbounded text for a
  // verbose VLM response (+ 10MB fruit plate image + Metal compiler
  // service memory) has been observed to exhaust V8's Zone allocator
  // on iOS, producing a SIGTRAP from FatalProcessOutOfMemory inside
  // Builtin_JsonStringify. Disk + console extractors only use metrics
  // + test name, so the output is already purely diagnostic.
  const OUTPUT_CAP_CHARS = 400

  createPerformanceReporter = function (opts) {
    const _results = []
    const _startedAt = new Date().toISOString()
    const _addon = (opts && opts.addon) || 'unknown'
    const _addonType = (opts && opts.addonType) || 'generic'
    const _device = {
      name: platform,
      platform,
      os_version: '',
      arch: os.arch ? os.arch() : '',
      runner: 'device-farm'
    }

    function _trim (text) {
      if (text == null) return null
      const s = String(text)
      if (s.length <= OUTPUT_CAP_CHARS) return s
      return s.substring(0, OUTPUT_CAP_CHARS) + '...[truncated ' +
        (s.length - OUTPUT_CAP_CHARS) + 'c]'
    }

    return {
      record (testName, metrics, extra) {
        const entry = {
          test: testName,
          execution_provider: (extra && extra.execution_provider) || null,
          metrics: Object.assign({
            backend: null,
            platform: null,
            total_time_ms: null,
            prefill_time_ms: null,
            decode_time_ms: null,
            vision_encode_time_ms: null,
            image_prefill_time_ms: null,
            ttft_ms: null,
            generated_tokens: null,
            prompt_tokens: null,
            tps: null,
            status: null
          }, metrics),
          input: (extra && extra.input) || null,
          output: _trim(extra && extra.output)
        }
        _results.push(entry)
      },
      toJSON () {
        return {
          schema_version: '1.0',
          addon: _addon,
          addon_type: _addonType,
          timestamp: _startedAt,
          device: _device,
          results: _results
        }
      },
      writeReport () {
        const json = JSON.stringify(this.toJSON())
        let written = false
        const dirs = []
        if (global.testDir) dirs.push(global.testDir)
        if (platform === 'android') {
          dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
          dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
          dirs.push('/data/local/tmp')
        }
        dirs.push('/tmp')
        for (let di = 0; di < dirs.length; di++) {
          try {
            try { fs.mkdirSync(dirs[di], { recursive: true }) } catch (_) {}
            const p = path.join(dirs[di], 'perf-report.json')
            fs.writeFileSync(p, json)
            console.log('[PERF_REPORT_PATH]' + p)
            written = true
          } catch (e) {
            console.log('[perf-reporter] write to ' + dirs[di] + ' failed: ' + e.message)
          }
        }
        if (!written) {
          console.log('[perf-reporter] all write locations failed')
        }
      },
      writeStepSummary () {},
      writeToConsole (consoleOpts) {
        try {
          const data = this.toJSON()
          const lightweight = consoleOpts && consoleOpts.lightweight
          // `delta: true` emits ONLY the latest row instead of the full
          // cumulative results array. Each JSON.stringify then stays
          // O(1) in the iteration count, which is essential on iOS
          // where V8's Zone allocator caps out fast under multimodal
          // memory pressure. extract-from-log.js --merge concatenates
          // the rows across all emits and dedupes on (test, metrics)
          // so the reconstructed report is identical to cumulative.
          const delta = consoleOpts && consoleOpts.delta
          let rows = data.results
          if (delta && rows.length > 0) rows = [rows[rows.length - 1]]
          data.results = rows.map(r => ({
            test: r.test,
            execution_provider: r.execution_provider,
            metrics: r.metrics,
            output: lightweight ? null : r.output
          }))
          const json = JSON.stringify(data)
          const CHUNK = 800
          if (json.length <= CHUNK) {
            console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
          } else {
            const id = Date.now().toString(36)
            const n = Math.ceil(json.length / CHUNK)
            for (let i = 0; i < n; i++) {
              console.log('[PERF_CHUNK:' + id + ':' + i + ':' + n + ']' + json.substring(i * CHUNK, (i + 1) * CHUNK))
            }
          }
        } catch (err) {
          console.log('[perf-reporter] mobile console write failed: ' + err.message)
        }
      },
      get length () { return _results.length }
    }
  }
}

// Singleton — shared across all image-*.test.js files loaded into the
// same bare process. When splits run per-image on Device Farm, each
// group is a separate process so the singleton only holds that image's
// data. On desktop, all three image files load into the same process
// and the singleton holds all rows for the combined perf report.
const _perfReporter = createPerformanceReporter({
  addon: 'llamacpp-llm',
  addonType: 'vision'
})

const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _exitHookInstalled = false

function _installExitHook () {
  if (_exitHookInstalled) return
  _exitHookInstalled = true
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      try { _perfReporter.writeReport(_reportPath) } catch (_) {}
      try { _perfReporter.writeStepSummary() } catch (_) {}
      // No extra cumulative console emit on mobile: the per-test
      // delta emits already carry every row, and extract-from-log.js
      // --merge reassembles them. Emitting a large cumulative payload
      // here risks a final Zone OOM in V8 on iOS right at the moment
      // we most need the previous deltas to survive.
    }
  })
}

// CPU-only platforms (no GPU inference path today)
const useCpu = isDarwinX64 || isLinuxArm64

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

// QVAC-17830: 1 warmup + N counted iterations per (image x backend).
// Matches OCR's PERF_RUNS=3 convention in
// packages/ocr-onnx/test/integration/doctr-*.test.js so aggregate.js
// produces a meaningful `count=3, mean, std` per cell.
const PERF_RUNS = 3
const PERF_WARMUP_RUNS = 1
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

  return { inference }
}

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

function _num (v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Records VLM perf metrics + (on mobile) flushes an incremental
 * snapshot to console / disk so data is preserved if a later
 * iteration crashes (e.g. iOS Jetsam OOM on the high-res image).
 */
function recordPerformance (label, totalTime, extra) {
  const stats = (extra && extra.stats) || null
  const totalSeconds = (totalTime / 1000).toFixed(2)

  const ttftMs = stats ? _num(stats.TTFT) : null
  const tps = stats ? _num(stats.TPS) : null
  const generatedTokens = stats ? _num(stats.generatedTokens) : null
  const promptTokens = stats ? _num(stats.promptTokens) : null

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

  _installExitHook()

  // Per-test flush: emit just this iteration's row to the console so
  // a crash on run N still leaves runs 1..N-1 in logcat / syslog.
  // extract-from-log.js --merge concatenates the deltas across emits.
  //
  // Deliberately NO writeReport() on disk per-record: (a) rewriting
  // the whole JSON on every iteration is expensive, and (b) the
  // stringify of the cumulative results array (plus model output
  // text) has been observed to exhaust V8's Zone allocator on iOS,
  // producing a SIGTRAP from FatalProcessOutOfMemory. The exit hook
  // below still performs one final writeReport for the on-device
  // artifact copy.
  if (isMobile) {
    if (typeof _perfReporter.writeToConsole === 'function') {
      _perfReporter.writeToConsole({ lightweight: true, delta: true })
    }
  }

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
    const { inference } = await setupMultimodalInference(t, deviceConfig.device)

    const imageFilePath = getMediaPath(testCase.imageFile)
    t.ok(fs.existsSync(imageFilePath), `${label} ${testCase.imageFile} image file should exist`)

    for (let w = 1; w <= PERF_WARMUP_RUNS; w++) {
      const { generatedText, startTime, endTime } =
        await describeImage(inference, imageFilePath, TEST_CONSTANTS.defaultPrompt)
      t.comment(
        `${label} warmup ${w}/${PERF_WARMUP_RUNS} (${endTime - startTime}ms, ` +
        `${generatedText.length} chars) - perf NOT recorded`
      )
    }

    let lastGeneratedText = ''
    for (let run = 1; run <= PERF_RUNS; run++) {
      const { generatedText, startTime, endTime, stats } =
        await describeImage(inference, imageFilePath, TEST_CONSTANTS.defaultPrompt)
      const totalTime = endTime - startTime
      lastGeneratedText = generatedText

      t.comment(`${label} run ${run}/${PERF_RUNS} Generated text: ${generatedText}`)
      t.comment(recordPerformance(label, totalTime, {
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
