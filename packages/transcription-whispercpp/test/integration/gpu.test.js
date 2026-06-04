'use strict'

// GPU test for transcription-whispercpp.
//
// Mirrors transcription-parakeet/test/integration/gpu-smoke.test.js: prove that
// the addon really engages a GPU backend on platforms where vcpkg.json wires one
// in, and prove that use_gpu=false really pins the engine to CPU.
//
// Strict gate via response.stats.backendDevice (0=CPU, 1=GPU) and
// response.stats.backendId (0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL,
// 99=other), surfaced by WhisperModel::runtimeStats() and documented in
// index.d.ts (RuntimeStats + BackendId enum). A use_gpu=true request that falls
// back to CPU surfaces as backendDevice=0, which fails the GPU assertion.
//
// Per vcpkg.json the expected GPU backend is Metal on darwin/ios, Vulkan on
// linux/win32, and Vulkan or OpenCL on android.
//
// CI runners without a real GPU export NO_GPU=true to skip the GPU half; the CPU
// half always runs. QVAC_WHISPER_GPU_RELAX=1 downgrades the GPU assertion to a
// warning for hosts where the GPU is genuinely unavailable (emulated /
// Paravirtual / low-tier mobile GPU).

const fs = require('bare-fs')
const os = require('bare-os')
const process = require('bare-process')
const test = require('brittle')

const TranscriptionWhispercpp = require('../../index.js')
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

function backendIdToName (id) {
  switch (id) {
    case 0: return 'CPU'
    case 1: return 'Metal'
    case 2: return 'CUDA'
    case 3: return 'Vulkan'
    case 4: return 'OpenCL'
    case 99: return 'other-GPU'
    default: return `unknown(${id})`
  }
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
  t.ok(
    typeof stats.backendDevice === 'number',
    `${label}: stats.backendDevice must be a number`
  )
  t.ok(
    typeof stats.backendId === 'number',
    `${label}: stats.backendId must be a number`
  )
}

function assertGpuBackend (t, label, stats) {
  if (!stats) {
    t.fail(`${label}: no response.stats returned (cannot verify backend)`)
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  const name = backendIdToName(id)
  console.log(`[${label}] backendDevice=${dev} backendId=${id} (${name})`)

  if (dev !== 1) {
    const msg = `${label}/${platform}: expected GPU backend, got ${name} ` +
                `(backendDevice=${dev}, backendId=${id}). ` +
                'use_gpu=true was requested but the engine fell back to CPU. ' +
                'Set QVAC_WHISPER_GPU_RELAX=1 to downgrade this to a warning ' +
                'on hosts without a usable GPU.'
    if (RELAX) {
      t.comment(`WARNING (relaxed): ${msg}`)
      t.pass(`${label}: GPU smoke completed (relaxed)`)
    } else {
      t.fail(msg)
    }
    return
  }

  if (platform === 'darwin' || platform === 'ios') {
    t.is(id, 1, `${label}/${platform}: expected Metal backendId=1, got ${name}`)
  } else if (platform === 'linux' || platform === 'win32') {
    t.is(id, 3, `${label}/${platform}: expected Vulkan backendId=3, got ${name}`)
  } else if (platform === 'android') {
    t.ok(id === 3 || id === 4,
      `${label}/${platform}: expected Vulkan(3) or OpenCL(4) backendId, got ${name}`)
  }
}

function assertCpuBackend (t, label, stats) {
  if (!stats) {
    t.fail(`${label}: no response.stats returned (cannot verify backend)`)
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  console.log(`[${label}] backendDevice=${dev} backendId=${id} (${backendIdToName(id)})`)
  t.is(dev, 0,
    `${label}: use_gpu=false must pin the engine to CPU (backendDevice=0), ` +
    `got backendDevice=${dev} (${backendIdToName(id)})`)
}

async function runCase (t, { useGpu, label }) {
  const modelPath = await ensureTinyModel()
  if (!modelPath) { t.pass(`${label}: skipped — ggml-tiny.bin not available locally`); return null }
  const samplePath = locateSampleAudio()
  if (!samplePath) { t.pass(`${label}: skipped — ${SAMPLE_AUDIO_NAME} not available locally`); return null }

  const result = await loadAndTranscribe({ modelPath, samplePath, useGpu })
  console.log(`[${label}] segments=${result.segments.length}`)
  assertStatsShape(t, label, result.stats)
  t.ok(
    result.segments.length > 0,
    `${label}: must produce at least 1 segment (got ${result.segments.length})`
  )
  return result
}

test(
  'Whisper GPU - use_gpu=true must engage the GPU backend on GPU-capable platforms',
  { timeout: 600000, skip: NO_GPU },
  async (t) => {
    if (platform === 'android') {
      t.pass('Android: Whisper GPU test quarantined pending teardown crash investigation (see mobile-perf-tiny-gpu.test.js)')
      return
    }
    const gpuRun = await runCase(t, { useGpu: true, label: 'GPU' })
    if (!gpuRun) return
    assertGpuBackend(t, 'GPU', gpuRun.stats)
  }
)

test(
  'Whisper CPU - use_gpu=false pins the engine to CPU on every platform',
  { timeout: 600000 },
  async (t) => {
    const cpuRun = await runCase(t, { useGpu: false, label: 'CPU' })
    if (!cpuRun) return
    assertCpuBackend(t, 'CPU', cpuRun.stats)
  }
)
