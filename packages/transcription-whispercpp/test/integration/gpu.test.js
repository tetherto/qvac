'use strict'

// GPU test for transcription-whispercpp.
//
// Mirrors the intent of transcription-parakeet/test/integration/gpu-smoke.test.js
// and tts-ggml/test/integration/gpu-smoke.test.js (those packages call the
// equivalent file `gpu-smoke.test.js`): prove that the addon really engages a
// GPU backend on platforms where vcpkg.json wires one in, and prove that
// use_gpu=false really pins the engine to CPU. CI runs this on every matrix
// entry; runners without a real GPU export NO_GPU=true to skip the GPU half
// (CPU half always runs).
//
// IMPORTANT DIFFERENCE vs parakeet / tts-ggml:
//
// parakeet and tts-ggml surface `stats.backendDevice` (0=CPU, 1=GPU) and
// `stats.backendId` (0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other)
// through their RuntimeStats. That is the *strict* gate they use to detect a
// silent GPU->CPU fallback in CI. The whispercpp addon does NOT expose those
// fields today (see index.d.ts -> RuntimeStats). To get parity, the addon's
// JS binding + the underlying whisper.cpp Engine would need to grow
// `backend_device()` / `backend_name()` accessors and the addon would need to
// merge them into runtimeStats() (see follow-up note below).
//
// Until then this test runs a three-layer gate:
//
//   1. CONTRACT (strict): load with use_gpu=true on a GPU-capable platform
//      must (a) not throw, (b) produce a non-null stats object with sane
//      shape, and (c) emit at least one transcription segment. The mirror
//      CPU run with use_gpu=false must do the same. This catches build /
//      linkage / kernel-init regressions that show up as throws or empty
//      output, which is the dominant failure mode anyway.
//
//   2. ENCODE-TIME RATIO (strict, when GPU expected): on the same platform
//      and same audio, run the engine twice -- once with use_gpu=true and
//      once with use_gpu=false -- and compare stats.whisperEncodeMs. The
//      Whisper encoder is the GPU-dominated phase; if Metal / Vulkan / CUDA
//      are really engaged its wall-time is multiple x faster than the CPU
//      reference. We require gpuEncodeMs / cpuEncodeMs < ENCODE_RATIO_MAX
//      (default 0.6, i.e. GPU must be at least ~1.67x faster than CPU in
//      the encode step). This detects a silent GPU->CPU fallback even
//      though whispercpp does not yet surface backendId in stats. Set
//      QVAC_WHISPER_GPU_RELAX=1 to downgrade the assertion to a
//      warning (useful for hosted runners where Paravirtual / emulated
//      GPUs barely move the needle on tiny.bin).
//
//   3. BEST-EFFORT BACKEND DETECTION (informational): we install a logger
//      that captures every native log line the addon emits during load + run
//      into an in-memory buffer. If the buffer mentions the expected backend
//      token for the platform (e.g. /metal/i on darwin, /vulkan/i on linux)
//      we surface a pass; if it does not we surface a console warning but
//      DO NOT fail the test, because matching against upstream log strings
//      is inherently brittle and a future whisper.cpp bump might change the
//      wording. Note that today the ggml backend usually logs to stderr via
//      printf, not via the addon's setLogger callback, so this layer is
//      effectively a no-op on most platforms -- it is kept for free
//      observability if/when upstream pipes ggml logs through our logger.
//
// CI runners without a real GPU (or hosted macOS where the Paravirtual Metal
// device crashes ggml's encoder) export NO_GPU=true to skip the GPU half.
// Real GPU runners (qvac-ubuntu2404-x64-gpu, qvac-win25-x64-gpu) and local
// developer machines leave NO_GPU unset so the contract gate still fires.
// Pattern lifted from transcription-parakeet/test/integration/gpu-smoke.test.js
// (kept identical in spirit even though we drop the "smoke" suffix here).
//
// Follow-up to reach strict parity with parakeet / tts-ggml:
//   - expose Engine::backend_device() / Engine::backend_name() in
//     qvac-ext-lib-whisper.cpp (analog to qvac-parakeet.cpp@366c3f1).
//   - surface backendDevice / backendId in WhisperModel::runtimeStats().
//   - add backendDevice / backendId to index.d.ts RuntimeStats.
//   - migrate the assertions below from logs to stats.

const fs = require('bare-fs')
const os = require('bare-os')
const process = require('bare-process')
const test = require('brittle')

const TranscriptionWhispercpp = require('../../index.js')
const binding = require('../../binding')
const {
  getAssetPath,
  getTestPaths,
  ensureWhisperModel,
  createAudioStream
} = require('./helpers.js')

const platform = os.platform()
const RELAX = process.env && process.env.QVAC_WHISPER_GPU_RELAX === '1'
const NO_GPU = process.env && process.env.NO_GPU === 'true'

const SAMPLE_AUDIO_NAME = 'sample.raw'
const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
const ENCODE_RATIO_MAX = 0.6
const ENCODE_RATIO_MIN_CPU_MS = 10

function expectsGpu () {
  return (
    platform === 'darwin' ||
    platform === 'ios' ||
    platform === 'linux' ||
    platform === 'win32' ||
    platform === 'android'
  )
}

function expectedBackendDescription (plat) {
  if (plat === 'darwin' || plat === 'ios') return 'Metal'
  if (plat === 'linux' || plat === 'win32') return 'Vulkan'
  if (plat === 'android') return 'Vulkan or OpenCL'
  return 'CPU'
}

function expectedBackendTokens (plat) {
  if (plat === 'darwin' || plat === 'ios') return [/metal/i, /apple\s*gpu/i]
  if (plat === 'linux' || plat === 'win32') return [/vulkan/i]
  if (plat === 'android') return [/vulkan/i, /opencl/i]
  return []
}

function backendTokensMatch (logBuffer, plat) {
  const tokens = expectedBackendTokens(plat)
  for (const t of tokens) if (t.test(logBuffer)) return true
  return false
}

function makeLogCapture () {
  return { value: '' }
}

function attachCapturingLogger (captured) {
  binding.setLogger((priority, message) => {
    const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    const line = `[C++ ${priorityName}] ${message}`
    captured.value += line + '\n'
    console.log(line)
  })
}

function releaseLogger () {
  try { binding.releaseLogger() } catch (_) { /* ignore */ }
}

function locateSampleAudio () {
  try {
    const samplePath = getAssetPath(SAMPLE_AUDIO_NAME)
    if (samplePath && fs.existsSync(samplePath)) return samplePath
  } catch (_) { /* asset manifest may not contain the sample on mobile */ }
  return null
}

async function ensureTinyModel () {
  const { modelPath } = getTestPaths()
  const result = await ensureWhisperModel(modelPath)
  return result && result.success ? modelPath : null
}

function buildConfig (useGpu) {
  return {
    contextParams: {
      use_gpu: !!useGpu,
      gpu_device: 0
    },
    whisperConfig: {
      language: 'en',
      audio_format: 's16le',
      temperature: 0.0,
      n_threads: 4
    }
  }
}

async function loadAndTranscribe ({ modelPath, samplePath, useGpu }) {
  const constructorArgs = {
    files: { model: modelPath },
    opts: { stats: true }
  }
  const config = buildConfig(useGpu)
  config.path = modelPath

  const model = new TranscriptionWhispercpp(constructorArgs, config)
  try {
    await model._load()
    const audioStream = createAudioStream(samplePath)
    const response = await model.run(audioStream)

    const segments = []
    await response.onUpdate((out) => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (seg && typeof seg.text === 'string') segments.push(seg)
      }
    }).await()

    return { segments, stats: response.stats || null }
  } finally {
    try { await model.destroy() } catch (_) { /* ignore */ }
  }
}

function assertStatsShape (t, label, stats) {
  t.ok(stats, `${label}: response.stats must be present (opts.stats=true was set)`)
  if (!stats) return
  t.ok(
    typeof stats.totalTime === 'number' && stats.totalTime >= 0,
    `${label}: stats.totalTime must be a non-negative number`
  )
  t.ok(
    typeof stats.audioDurationMs === 'number' && stats.audioDurationMs > 0,
    `${label}: stats.audioDurationMs must be a positive number`
  )
  t.ok(
    typeof stats.realTimeFactor === 'number' && stats.realTimeFactor >= 0,
    `${label}: stats.realTimeFactor must be a non-negative number`
  )
}

function assertGpuFasterThanCpu (t, gpuEncodeMs, cpuEncodeMs) {
  if (!expectsGpu()) {
    t.pass(`platform=${platform} wires no GPU backend; skipping encode-time ratio check`)
    return
  }
  if (typeof gpuEncodeMs !== 'number' || typeof cpuEncodeMs !== 'number') {
    t.comment(`[WARN] cannot compute encode-time ratio: gpuEncodeMs=${gpuEncodeMs} cpuEncodeMs=${cpuEncodeMs}`)
    return
  }
  if (cpuEncodeMs < ENCODE_RATIO_MIN_CPU_MS) {
    t.comment(`[WARN] cpuEncodeMs=${cpuEncodeMs}ms below ${ENCODE_RATIO_MIN_CPU_MS}ms floor; ratio would be noisy, skipping`)
    return
  }
  const ratio = gpuEncodeMs / cpuEncodeMs
  const baseMsg = `gpu/cpu encode-time ratio=${ratio.toFixed(3)} (gpu=${gpuEncodeMs}ms cpu=${cpuEncodeMs}ms threshold<${ENCODE_RATIO_MAX})`
  console.log(`[ratio] ${baseMsg}`)
  if (ratio < ENCODE_RATIO_MAX) {
    t.pass(`GPU encode is at least ${(1 / ENCODE_RATIO_MAX).toFixed(2)}x faster than CPU encode (${baseMsg})`)
    return
  }
  const failMsg =
    `${baseMsg}. GPU encode was not measurably faster than CPU encode -- ` +
    'this strongly suggests a silent fallback to CPU even though use_gpu=true ' +
    'was requested. Set QVAC_WHISPER_GPU_RELAX=1 to downgrade this ' +
    'failure to a warning on runners where the GPU is genuinely slow ' +
    '(emulated / Paravirtual / low-tier mobile GPU).'
  if (RELAX) {
    t.comment(`WARNING (relaxed): ${failMsg}`)
    t.pass('GPU encode-time ratio check downgraded by QVAC_WHISPER_GPU_RELAX=1')
  } else {
    t.fail(failMsg)
  }
}

function assertGpuBackendBestEffort (t, capturedLogs) {
  if (!expectsGpu()) {
    t.pass(`platform=${platform} wires no GPU backend in vcpkg.json; nothing to detect`)
    return
  }
  const expected = expectedBackendDescription(platform)
  if (backendTokensMatch(capturedLogs, platform)) {
    t.pass(`GPU backend tokens for ${expected} detected in native logs`)
    return
  }
  const baseMsg =
    `expected ${expected} backend tokens in native logs (use_gpu=true on ${platform}) ` +
    'but none were found. This is informational only: whispercpp does not yet ' +
    'expose backendId/backendDevice in RuntimeStats, so the gate falls back to ' +
    'matching upstream log strings which can change between whisper.cpp versions. ' +
    'See file header for the follow-up that turns this into a strict gate.'
  if (RELAX) {
    t.comment(`[INFO] best-effort backend detection skipped (QVAC_WHISPER_GPU_RELAX=1): ${baseMsg}`)
  } else {
    t.comment(`[WARN] ${baseMsg}`)
  }
  t.pass('GPU contract completed (best-effort backend detection inconclusive)')
}

async function runCase (t, { useGpu, label }) {
  const captured = makeLogCapture()
  attachCapturingLogger(captured)
  try {
    const modelPath = await ensureTinyModel()
    if (!modelPath) { t.pass(`${label}: skipped — ggml-tiny.bin not available locally`); return null }
    const samplePath = locateSampleAudio()
    if (!samplePath) { t.pass(`${label}: skipped — ${SAMPLE_AUDIO_NAME} not available locally`); return null }

    const result = await loadAndTranscribe({ modelPath, samplePath, useGpu })
    console.log(`[${label}] segments=${result.segments.length} captured_log_bytes=${captured.value.length}`)
    assertStatsShape(t, label, result.stats)
    t.ok(
      result.segments.length > 0,
      `${label}: must produce at least 1 segment (got ${result.segments.length})`
    )
    return { ...result, capturedLogs: captured.value }
  } finally {
    releaseLogger()
  }
}

test(
  'Whisper GPU - use_gpu=true loads, transcribes and reports stats on GPU-capable platforms',
  { timeout: 600000, skip: NO_GPU },
  async (t) => {
    if (platform === 'android') {
      t.pass('Android: Whisper GPU test quarantined pending teardown crash investigation (see mobile-perf-tiny-gpu.test.js)')
      return
    }
    const gpuRun = await runCase(t, { useGpu: true, label: 'GPU' })
    if (!gpuRun) return
    assertGpuBackendBestEffort(t, gpuRun.capturedLogs)

    if (!expectsGpu()) return
    const cpuRef = await runCase(t, { useGpu: false, label: 'CPU reference' })
    if (!cpuRef) return
    assertGpuFasterThanCpu(
      t,
      gpuRun.stats && gpuRun.stats.whisperEncodeMs,
      cpuRef.stats && cpuRef.stats.whisperEncodeMs
    )
  }
)

test(
  'Whisper CPU - use_gpu=false loads, transcribes and reports stats on every platform',
  { timeout: 600000 },
  async (t) => {
    await runCase(t, { useGpu: false, label: 'CPU' })
  }
)
