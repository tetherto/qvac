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

  return {
    data: {
      sampleCount,
      sampleRate,
      channels,
      durationMs,
      chunkCount: chunks.length,
      stages: [...stages],
      stats
    }
  }
}

module.exports = {
  NO_GPU,
  INTEGRATION_TIMEOUT_MS,
  loadAudioGen,
  runAudioGen
}
