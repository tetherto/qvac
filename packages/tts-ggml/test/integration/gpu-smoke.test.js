'use strict'

// GPU smoke tests for both tts-ggml engines (chatterbox + supertonic).
//
// Mirrors qvac-lib-infer-parakeet/test/integration/gpu-smoke.test.js's
// strict-on-CPU policy: a useGPU=true request that resolves to the CPU
// backend on a GPU-capable platform is treated as a regression because
// it usually means a build / linkage / kernel-init drift that CI must
// catch.  Set QVAC_TTS_GPU_SMOKE_RELAX=1 to downgrade the gate to a
// warning (e.g. for a Linux host without Vulkan SDK, an emulator
// without Metal, or an Adreno-tier device that ggml-opencl rejects by
// design).
//
// CI runners without a real GPU (or hosted macOS where the
// Paravirtual Metal device crashes ggml's encoder) export NO_GPU=true
// to skip every smoke entry.  Real GPU runners and local dev leave
// NO_GPU unset so the strict assertions still fire there.
//
// The strict gate uses `response.stats.backendDevice` (0=CPU, 1=GPU)
// and `response.stats.backendId` (0=CPU, 1=Metal, 2=CUDA, 3=Vulkan,
// 4=OpenCL, 99=other), both surfaced by ChatterboxModel +
// SupertonicModel after Engine::backend_device() / backend_name() were
// added in tts-cpp.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const RELAX = proc.env && proc.env.QVAC_TTS_GPU_SMOKE_RELAX === '1'
const NO_GPU = proc.env && proc.env.NO_GPU === 'true'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

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

// Which platforms wire up a GPU backend in tts-cpp's vcpkg port
// today (default-features in qvac-registry-vcpkg/ports/tts-cpp/vcpkg.json):
//   - darwin / ios:        metal
//   - linux / win32:       vulkan
//   - android:             vulkan + opencl
function expectsGpu () {
  return (
    platform === 'darwin' ||
    platform === 'ios' ||
    platform === 'linux' ||
    platform === 'win32' ||
    platform === 'android'
  )
}

function assertGpuBackend (t, engineTag, stats) {
  if (!stats) {
    t.fail(`${engineTag}/GPU: no response.stats returned (cannot verify backend)`)
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  const name = backendIdToName(id)
  console.log(`[${engineTag}/GPU] backendDevice=${dev} backendId=${id} (${name})`)

  if (!expectsGpu()) {
    t.is(dev, 0, `${engineTag}/${platform}: backendDevice must be 0 (CPU) on platforms with no GPU wired in`)
    return
  }

  if (dev !== 1) {
    const msg = `${engineTag}/${platform}: expected GPU backend, got ${name} (backendDevice=${dev}, backendId=${id}). ` +
                'useGPU=true was requested but the engine fell back to CPU. ' +
                'Inspect addon native logs for the load-time backend init message.'
    if (RELAX) {
      t.comment(`WARNING (relaxed): ${msg}`)
      t.pass(`${engineTag}/GPU smoke completed (relaxed)`)
    } else {
      t.fail(msg)
    }
    return
  }

  if (platform === 'darwin' || platform === 'ios') {
    t.is(id, 1, `${engineTag}/${platform}: expected Metal backendId=1, got ${name}`)
  } else if (platform === 'linux' || platform === 'win32') {
    t.is(id, 3, `${engineTag}/${platform}: expected Vulkan backendId=3, got ${name}`)
  } else if (platform === 'android') {
    t.ok(id === 3 || id === 4, `${engineTag}/${platform}: expected Vulkan(3) or OpenCL(4) backendId, got ${name}`)
  }
}

test('Chatterbox GPU smoke - useGPU=true must engage the GPU backend on GPU-capable platforms', { timeout: 600000, skip: NO_GPU }, async (t) => {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')

  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    t.pass('Skipped: Chatterbox GGUFs not available locally')
    return
  }

  const refWavPath = path.join(__dirname, '..', 'reference-audio', 'jfk.wav')
  if (!fs.existsSync(refWavPath)) {
    t.pass('Skipped: reference audio missing')
    return
  }

  const model = await loadChatterboxTTS({
    modelDir: download.targetDir,
    refWavPath,
    language: 'en',
    useGPU: true
  })
  try {
    const result = await runChatterboxTTS(
      model,
      { text: 'GPU smoke check.' },
      { minSamples: 5000 }
    )
    console.log(result.output)
    t.ok(result.passed, 'Chatterbox/GPU produced expected sample count')
    t.ok(result.data.sampleCount > 0, 'Chatterbox/GPU produced audio')
    assertGpuBackend(t, 'Chatterbox', result.data.stats)
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic GPU smoke - useGPU=true is rejected at constructor (engine is CPU-only today)', { timeout: 60000 }, async (t) => {
  const TTSGgml = require('@qvac/tts-ggml')
  let threw = false
  try {
    /* eslint no-new: 0 */
    new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: { supertonicModel: '/dev/null' },
      voice: 'F1',
      config: { language: 'en', useGPU: true }
    })
  } catch (e) {
    threw = true
    t.ok(/CPU only today/.test(e.message),
      'rejection message references the engine docstring')
    t.ok(/Pass config:.*useGPU: false/.test(e.message),
      'rejection message tells user how to fix')
  }
  t.ok(threw, 'TTSGgml constructor should throw on Supertonic + useGPU:true')
})
