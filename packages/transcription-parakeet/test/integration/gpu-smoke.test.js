'use strict'

// GPU smoke tests across all 4 parakeet model types.
//
// Today every other integration test sets `useGPU: false`, so the
// integration matrix only exercises the CPU fallback path on real
// devices. This file flips the switch with `useGPU: true` so that on
//   - macOS / iOS:    Metal is engaged
//   - Linux / Windows: Vulkan is engaged
//   - Android:         Vulkan is preferred, OpenCL is the fallback
//                      (Adreno only; non-Adreno phones may silently
//                      fall back to CPU at ggml_cl2_init)
//
// The strict gate uses `response.stats.backendDevice` (0 = CPU, 1 = GPU)
// and `response.stats.backendId` (0=CPU, 1=Metal, 2=CUDA, 3=Vulkan,
// 4=OpenCL, 99=other). Both are surfaced by ParakeetModel::runtimeStats()
// after qvac-parakeet.cpp@366c3f1 added Engine::backend_device() /
// Engine::backend_name(). See `index.d.ts` BackendId enum.
//
// Strict-on-CPU policy (today): we fail the test on any GPU-capable
// platform if the active backend is CPU. The reasoning is that for
// LOCAL development and CI we want a hard signal that the GPU path
// actually engaged -- a silent CPU fallback hides build / linkage /
// kernel-init regressions. Set `QVAC_PARAKEET_GPU_SMOKE_RELAX=1` to
// downgrade the gate to a warning (useful e.g. for an Android emulator
// or iOS simulator without GPU support, an Adreno-6xx phone where
// ggml-opencl rejects the device by design, or a Linux/Windows host
// without a Vulkan-capable GPU / Vulkan SDK).
//
// Caveats / known limitations:
//   1. CTC is intentionally not bundled on mobile (helpers.js
//      MODEL_CONFIGS comment); `loadGgufOrSkip` returns null with a
//      `t.pass` on mobile-CTC, so the CTC test is effectively a no-op
//      on Android/iOS.
//   2. The "GPU is expected here" decision is platform-driven (see
//      `expectsGpu()` below). All four supported platforms (darwin,
//      ios, linux, win32, android) wire a GPU backend by default in
//      transcription-parakeet/vcpkg.json, so any CPU result on those
//      platforms is treated as a regression (modulo
//      QVAC_PARAKEET_GPU_SMOKE_RELAX).

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')
const {
  binding,
  TranscriptionParakeet,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip,
  platform
} = require('./helpers.js')

const { samplesDir } = getTestPaths()

const RELAX = process.env && process.env.QVAC_PARAKEET_GPU_SMOKE_RELAX === '1'

// CI workflows that run on hosted runners without a real GPU (or on
// macOS hosted runners where Metal exposes only an "Apple Paravirtual
// device" that crashes ggml's encoder graph on MUL_MAT) export
// NO_GPU=true to skip every GPU smoke entry. Real GPU runners
// (`ai-run-linux-gpu`, etc.) and local developer machines leave NO_GPU
// unset so the strict assertions still fire there. Pattern lifted from
// llm-llamacpp's integration tests.
const NO_GPU = process.env && process.env.NO_GPU === 'true'

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

// Which platforms wire up a GPU backend in transcription-parakeet's
// vcpkg.json today (see the `parakeet-cpp` feature dependencies).
//   - darwin / ios:        metal              (default)
//   - linux / win32:       vulkan             (default)
//   - android:             vulkan + opencl    (default; Adreno only)
function expectsGpu () {
  return (
    platform === 'darwin' ||
    platform === 'ios' ||
    platform === 'linux' ||
    platform === 'win32' ||
    platform === 'android'
  )
}

function loadAudioSample () {
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) return null
  const rawBuffer = fs.readFileSync(samplePath)
  const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audio = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768.0
  return audio
}

async function transcribe (model, audio) {
  const segments = []
  const response = await model.run(audio)
  await response
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (seg && seg.text) segments.push(seg)
      }
    })
    .await()
  return { segments, stats: response.stats || null }
}

function assertGpuBackend (t, modelType, stats) {
  if (!stats) {
    t.fail(`${modelType}/GPU: no response.stats returned (cannot verify backend)`)
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  const name = backendIdToName(id)
  console.log(`[${modelType}/GPU] backendDevice=${dev} backendId=${id} (${name})`)

  if (!expectsGpu()) {
    // Platforms with no GPU backend wired into the addon today must
    // resolve to CPU. This catches accidental GPU-on-Linux config drift.
    t.is(dev, 0,
      `${modelType}/${platform}: backendDevice must be 0 (CPU) on platforms with no GPU wired in`)
    return
  }

  if (dev !== 1) {
    const msg = `${modelType}/${platform}: expected GPU backend, got ${name} ` +
                `(backendDevice=${dev}, backendId=${id}). ` +
                'useGPU=true was requested but the engine fell back to CPU. ' +
                'Inspect the addon\'s --native-logs output for the load-time ' +
                'backend init message.'
    if (RELAX) {
      t.comment(`WARNING (relaxed): ${msg}`)
      t.pass(`${modelType}/GPU smoke completed (relaxed)`)
    } else {
      t.fail(msg)
    }
    return
  }

  // Sanity: the active GPU on this platform should match the addon's
  // build-time backend selection. Don't be too prescriptive here: if a
  // future build wires CUDA on darwin (e.g. eGPU) we'd rather pass
  // than break unnecessarily. We just require "the right family":
  if (platform === 'darwin' || platform === 'ios') {
    t.is(id, 1, `${modelType}/${platform}: expected Metal backendId=1, got ${name}`)
  } else if (platform === 'linux' || platform === 'win32') {
    t.is(id, 3, `${modelType}/${platform}: expected Vulkan backendId=3, got ${name}`)
  } else if (platform === 'android') {
    t.ok(id === 3 || id === 4,
      `${modelType}/${platform}: expected Vulkan(3) or OpenCL(4) backendId, got ${name}`)
  }
}

async function runGpuModelTest (t, modelType, modelPath, audio, expectations) {
  const model = new TranscriptionParakeet({
    files: { model: modelPath },
    config: { parakeetConfig: { modelType, maxThreads: 4, useGPU: true } }
  })
  try {
    await model.load()
    const { segments, stats } = await transcribe(model, audio)
    const joiner = modelType === 'sortformer' ? '\n' : ' '
    const fullText = segments.map(s => s.text).join(joiner).trim()
    console.log(`[${modelType}/GPU] segments=${segments.length} chars=${fullText.length}`)
    console.log(`[${modelType}/GPU] result: "${fullText.substring(0, 120)}${fullText.length > 120 ? '...' : ''}"`)

    assertGpuBackend(t, modelType, stats)

    t.ok(segments.length > 0,
      `${modelType}/GPU produced ${segments.length} segments`)
    if (expectations.containsSpeaker) {
      t.ok(fullText.includes('Speaker'),
        `${modelType}/GPU output contains speaker labels`)
    } else {
      t.ok(fullText.length >= expectations.minTextLength,
        `${modelType}/GPU produced text (${fullText.length} chars)`)
    }
  } finally {
    try { await model.unload() } catch (e) { /* ignore */ }
  }
}

test('CTC GPU smoke — useGPU=true must engage the GPU backend on GPU-capable platforms', { timeout: 600000, skip: NO_GPU }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'ctc')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }
    await runGpuModelTest(t, 'ctc', modelPath, audio, { minTextLength: 10 })
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

test('TDT GPU smoke — useGPU=true must engage the GPU backend on GPU-capable platforms', { timeout: 600000, skip: NO_GPU }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'tdt')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }
    await runGpuModelTest(t, 'tdt', modelPath, audio, { minTextLength: 10 })
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

// EOU on offline mode runs the joint-network ASR path; on a clip with
// real speech that must produce non-empty text. minTextLength=1 catches
// the zero-token regression triggered by ggml-metal's Q-variant
// mul_mv + bias/residual fusion on the EOU q8_0 joint network.
test('EOU GPU smoke — useGPU=true must engage the GPU backend on GPU-capable platforms', { timeout: 600000, skip: NO_GPU }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'eou')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }
    await runGpuModelTest(t, 'eou', modelPath, audio, { minTextLength: 1 })
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

test('Sortformer GPU smoke — useGPU=true must engage the GPU backend on GPU-capable platforms', { timeout: 600000, skip: NO_GPU }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'sortformer')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) { t.pass('sample.raw not found — skipping'); return }
    await runGpuModelTest(t, 'sortformer', modelPath, audio, { containsSpeaker: true })
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})
