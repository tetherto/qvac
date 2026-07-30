'use strict'

// Run driver for the audiogen-ggml desktop integration suite. Loads an AudioGen
// instance and drives one generation, collecting the streamed PCM chunks,
// progress stages, and terminal stats into a single result object the tests can
// assert on. Mirrors the shape of tts-ggml/test/utils/runTTS.js.

const proc = require('bare-process')
const { AudioGen } = require('@qvac/audiogen-ggml')

// GPU gating: CI sets NO_GPU=true on the CPU-only matrix entries; the tests then
// force useGPU:false so a GPU-requested run never hits a machine with no GPU.
const NO_GPU = proc.env.NO_GPU === 'true'

// Per-test timeout (ms). Music generation (model load + DiT diffusion) is heavy,
// so honour the CI-provided INTEGRATION_TEST_TIMEOUT (seconds) and default high.
const INTEGRATION_TIMEOUT_MS = (Number(proc.env.INTEGRATION_TEST_TIMEOUT) || 1800) * 1000

// Construct + load an AudioGen. `useGPU` is only honoured when the runner has a
// GPU (NO_GPU !== 'true'); otherwise it is forced false.
async function loadAudioGen({
  modelDir,
  ditVariant = 'turbo-q4',
  useGPU = false,
  inferenceSteps,
  shift,
  threads
} = {}) {
  const config = { useGPU: useGPU === true && !NO_GPU }
  if (typeof inferenceSteps === 'number') config.inferenceSteps = inferenceSteps
  if (typeof shift === 'number') config.shift = shift
  if (typeof threads === 'number') config.threads = threads

  const gen = new AudioGen({ files: { modelDir, ditVariant }, config })
  await gen.load()
  return gen
}

// Drive one generation. Returns { data: { sampleCount, sampleRate, channels,
// durationMs, chunkCount, stages, stats } }. `stages` is the set of progress
// stage names seen (lm/dit/vae); `stats` is the terminal run stats.
async function runAudioGen(gen, { caption, opts = {} } = {}) {
  const response = await gen.run(caption, opts)

  const chunks = []
  const stages = new Set()
  let sampleRate = 0
  let channels = 0

  for await (const item of response.iterate()) {
    if (item && item.progress) {
      if (item.progress.stage) stages.add(item.progress.stage)
      continue
    }
    if (item && item.outputArray) {
      chunks.push(item.outputArray)
      sampleRate = item.sampleRate || sampleRate
      channels = item.channels || channels
    }
  }

  const stats = await response.await()

  let sampleCount = 0
  for (const chunk of chunks) sampleCount += chunk.length

  const durationMs =
    sampleRate > 0 && channels > 0 ? (sampleCount / channels / sampleRate) * 1000 : 0

  // Loudness of the interleaved int16 PCM, normalised to [0,1]. `sampleCount > 0`
  // alone cannot tell a real render from a buffer of silence, which is what a
  // miscomputing GPU kernel tends to produce, so the tests assert on these.
  let peakAbs = 0
  let sumSquares = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i] / 32768
      const a = v < 0 ? -v : v
      if (a > peakAbs) peakAbs = a
      sumSquares += v * v
    }
  }
  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0

  return {
    data: {
      sampleCount,
      sampleRate,
      channels,
      durationMs,
      chunkCount: chunks.length,
      stages: [...stages],
      peak: peakAbs,
      rms,
      stats
    }
  }
}

// Human-readable name for an AudiogenStats.backendId. Mirrors @qvac/tts-ggml.
function backendIdToName(id) {
  switch (id) {
    case 0:
      return 'CPU'
    case 1:
      return 'Metal'
    case 2:
      return 'CUDA'
    case 3:
      return 'Vulkan'
    case 4:
      return 'OpenCL'
    default:
      return 'other-GPU'
  }
}

module.exports = {
  NO_GPU,
  INTEGRATION_TIMEOUT_MS,
  loadAudioGen,
  runAudioGen,
  backendIdToName
}
