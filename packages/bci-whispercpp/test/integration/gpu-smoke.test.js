'use strict'

// GPU smoke tests for bci-whispercpp.
//
// Mirrors tts-ggml / transcription-parakeet gpu-smoke.test.js's strict-on-CPU
// policy: a use_gpu=true request that resolves to the CPU backend on a
// GPU-capable platform is treated as a regression, because it usually means a
// build / linkage / backend-init drift that CI must catch. The BCI engine
// wraps whisper.cpp, which only attempts a GPU backend when
// contextParams.use_gpu is true and reports the backend it actually
// initialised against via RuntimeStats.backendDevice / backendId.
//
// Set QVAC_BCI_GPU_SMOKE_RELAX=1 to downgrade the GPU gate to a warning (e.g.
// a Linux host without a CUDA/Vulkan SDK, or an emulator without Metal).
// CI runners without a real GPU export NO_GPU=true to skip the GPU entry; the
// CPU entry always runs (CPU works everywhere).
//
// Strict gate uses response.stats (opts: { stats: true }):
//   backendDevice : 0 = CPU, 1 = GPU (post-fallback truth)
//   backendId     : 0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL, 99 = other

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const BCIWhispercpp = require('../../index')
const { getTestPaths, getModelPath, detectPlatform } = require('./helpers')
const { flattenSegments } = require('@qvac/bci-whispercpp/util')

const { platform } = detectPlatform()
const RELAX = os.hasEnv('QVAC_BCI_GPU_SMOKE_RELAX') && os.getEnv('QVAC_BCI_GPU_SMOKE_RELAX') === '1'
const NO_GPU = os.hasEnv('NO_GPU') && os.getEnv('NO_GPU') === 'true'

const { manifest, getSamplePath } = getTestPaths()

const MODEL_PATH = (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  getModelPath('ggml-bci-windowed.bin')
const EMBEDDER_PATH = path.join(path.dirname(MODEL_PATH), 'bci-embedder.bin')
const hasModel = fs.existsSync(MODEL_PATH)

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

// Which platforms wire up a GPU backend in bci-whispercpp's vcpkg build today:
//   - darwin / ios:   Metal
//   - linux / win32:  CUDA or Vulkan
//   - android:        Vulkan / OpenCL
function expectsGpu () {
  return (
    platform === 'darwin' ||
    platform === 'ios' ||
    platform === 'linux' ||
    platform === 'win32' ||
    platform === 'android'
  )
}

function assertGpuBackend (t, stats) {
  if (!stats) {
    t.fail('BCI/GPU: no response.stats returned (cannot verify backend). Did you pass opts:{stats:true}?')
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  const name = backendIdToName(id)
  console.log(`[BCI/GPU] backendDevice=${dev} backendId=${id} (${name})`)

  if (!expectsGpu()) {
    t.is(dev, 0, `BCI/${platform}: backendDevice must be 0 (CPU) on platforms with no GPU wired in`)
    return
  }

  if (dev !== 1) {
    const msg = `BCI/${platform}: expected GPU backend, got ${name} (backendDevice=${dev}, backendId=${id}). ` +
                'use_gpu=true was requested but whisper fell back to CPU. ' +
                'Inspect the addon load-time backend init log.'
    if (RELAX) {
      t.comment(`WARNING (relaxed): ${msg}`)
      t.pass('BCI/GPU smoke completed (relaxed)')
    } else {
      t.fail(msg)
    }
    return
  }

  // Require the right backend family for the platform (not the exact id, so a
  // future eGPU/alternate-vendor build doesn't break unnecessarily).
  if (platform === 'darwin' || platform === 'ios') {
    t.is(id, 1, `BCI/${platform}: expected Metal backendId=1, got ${name}`)
  } else if (platform === 'linux' || platform === 'win32') {
    t.ok(id === 2 || id === 3, `BCI/${platform}: expected CUDA(2) or Vulkan(3) backendId, got ${name}`)
  } else if (platform === 'android') {
    t.ok(id === 3 || id === 4, `BCI/${platform}: expected Vulkan(3) or OpenCL(4) backendId, got ${name}`)
  }
}

function assertCpuBackend (t, stats) {
  if (!stats) {
    t.fail('BCI/CPU: no response.stats returned (cannot verify backend). Did you pass opts:{stats:true}?')
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  console.log(`[BCI/CPU] backendDevice=${dev} backendId=${id} (${backendIdToName(id)})`)
  t.is(dev, 0, `BCI: use_gpu:false must resolve to backendDevice=0 (CPU), got ${backendIdToName(id)}`)
  t.is(id, 0, `BCI: use_gpu:false must resolve to backendId=0 (CPU), got ${backendIdToName(id)}`)
}

function firstSample () {
  const sample = manifest.samples && manifest.samples[0]
  if (!sample) return null
  const samplePath = getSamplePath(sample.file)
  return fs.existsSync(samplePath) ? { sample, samplePath } : null
}

async function runBci (useGpu, samplePath, sample) {
  const bci = new BCIWhispercpp({
    files: { model: MODEL_PATH, embedder: EMBEDDER_PATH },
    opts: { stats: true }
  }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false },
    contextParams: { use_gpu: useGpu },
    ...(typeof sample?.day_idx === 'number' ? { bciConfig: { day_idx: sample.day_idx } } : {})
  })
  await bci.load()
  try {
    const response = await bci.transcribeFile(samplePath)
    const output = await response.await()
    const segments = flattenSegments(output)
    const text = segments.map(s => s.text).join('').trim()
    return { stats: response.stats, text }
  } finally {
    await bci.destroy()
  }
}

test('[BCI] GPU smoke - use_gpu=true must engage the GPU backend on GPU-capable platforms', { timeout: 120000, skip: NO_GPU || !hasModel }, async (t) => {
  const picked = firstSample()
  if (!picked) {
    t.pass('Skipped: no neural-signal fixture available')
    return
  }
  const { stats, text } = await runBci(true, picked.samplePath, picked.sample)
  t.ok(typeof text === 'string' && text.length > 0, 'BCI/GPU produced a transcription')
  assertGpuBackend(t, stats)
})

test('[BCI] CPU smoke - use_gpu=false must run on the CPU backend', { timeout: 120000, skip: !hasModel }, async (t) => {
  const picked = firstSample()
  if (!picked) {
    t.pass('Skipped: no neural-signal fixture available')
    return
  }
  const { stats, text } = await runBci(false, picked.samplePath, picked.sample)
  t.ok(typeof text === 'string' && text.length > 0, 'BCI/CPU produced a transcription')
  assertCpuBackend(t, stats)
})
