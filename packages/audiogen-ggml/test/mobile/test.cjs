'use strict'

// Mobile on-device tests for @qvac/audiogen-ggml.
//
// The qvac-test-addon-mobile runner extracts every top-level `async function`
// here and exposes it as an independent PASS/FAIL test on the device. Helper
// functions are prefixed with `_` so the runner skips them.
//
// Runtime globals provided by the runner:
//   dirPath              testAssets directory on device
//   getAssetPath(name)   resolves a bundled asset to its on-device path
//   global.testDir       writable base dir (Documents/app sandbox)
//
// ACE-Step GGUFs are ~4.3 GB, far too large to bundle in testAssets, so they
// are side-loaded onto the device under `<testDir>/models/` (adb push on
// Android, app container / Files on iOS). The tests read them from there.

const fs = require('bare-fs')
const path = require('bare-path')
// Import by package name: on device this file is flattened into the runner's
// backend.cjs, so a relative require('..') would not resolve to the addon.
const { AudioGen } = require('@qvac/audiogen-ggml')

// Turbo profile: fast 8-step schedule, short clip -> keeps on-device wall time
// and peak RAM bounded for a smoke run.
const TURBO_STEPS = 8
const TURBO_SHIFT = 3.0
const SMOKE_DURATION_S = 10
const SMOKE_CAPTION = 'Upbeat pop rock with driving electric guitars, punchy drums and a catchy hook'

function _modelDir () {
  const candidates = []
  try {
    if (typeof process !== 'undefined' && process.env && process.env.AUDIOGEN_MODEL_DIR) {
      candidates.push(process.env.AUDIOGEN_MODEL_DIR)
    }
  } catch (_e) {}
  if (global.testDir) candidates.push(path.join(global.testDir, 'models'))
  if (typeof dirPath === 'string' && dirPath) candidates.push(path.join(dirPath, 'models'))

  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir
    } catch (_e) {}
  }
  throw new Error(
    'ACE-Step models not found on device. Side-load the GGUFs into ' +
    (global.testDir ? path.join(global.testDir, 'models') : '<testDir>/models') +
    ' (Qwen3-Embedding, acestep-5Hz-lm, acestep-v15-turbo, vae). Checked: ' +
    candidates.join(', ')
  )
}

function _findGguf (dir, needle) {
  const hit = fs.readdirSync(dir).find((f) =>
    f.toLowerCase().includes(needle) && f.toLowerCase().endsWith('.gguf'))
  return hit ? path.join(dir, hit) : undefined
}

function _makeGen (modelDir) {
  return new AudioGen({
    files: {
      modelDir,
      ditModel: _findGguf(modelDir, 'turbo')
    },
    config: {
      inferenceSteps: TURBO_STEPS,
      shift: TURBO_SHIFT,
      useGPU: false
    }
  })
}

// Wrap interleaved Int16 PCM in a canonical 44-byte PCM WAV header. Kept inline
// (not imported from the addon) so the flattened backend bundle stays self-contained.
function _pcmToWav (pcm, sampleRate, channels) {
  const byteRate = sampleRate * channels * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)          // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32) // block align
  header.writeUInt16LE(16, 34)           // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// Persist a copy of the rendered WAV next to the models dir so it survives the
// runner's post-playback cleanup and can be pulled off-device (AFC / adb).
function _persistWav (modelDir, wav) {
  try {
    const outDir = path.dirname(modelDir)
    const outPath = path.join(outDir, 'audiogen_phone.wav')
    fs.writeFileSync(outPath, wav)
    console.log('[audiogen-mobile] wrote ' + outPath + ' (' + wav.length + ' bytes)')
    return outPath
  } catch (e) {
    console.log('[audiogen-mobile] could not persist wav: ' + (e && e.message))
    return undefined
  }
}

// Load every stage GGUF and tear down again — cheap smoke to isolate model
// load (I/O + parse + graph alloc) from full diffusion inference.
async function testLoadModels () {
  const modelDir = _modelDir()
  console.log('[audiogen-mobile] model dir: ' + modelDir)
  console.log('[audiogen-mobile] files: ' + fs.readdirSync(modelDir).join(', '))

  const gen = _makeGen(modelDir)
  const t0 = Date.now()
  await gen.load()
  const loadMs = Date.now() - t0
  await gen.destroy()

  return {
    summary: { total: 1, passed: 1, failed: 0 },
    fullText: 'ACE-Step models loaded + freed in ' + loadMs + ' ms'
  }
}

// End-to-end generation of a short turbo clip. Returns interleaved Int16 PCM so
// the runner can play it back on device.
async function testGenerateMusic () {
  const modelDir = _modelDir()

  const chunks = []
  let sampleRate = 48000
  let channels = 2

  const gen = _makeGen(modelDir)
  await gen.load()

  const t0 = Date.now()
  // run() returns a @qvac/infer-base QvacResponse: iterate() streams progress
  // ticks + the interleaved-Int16 PCM chunk(s); await() resolves the run stats.
  const response = await gen.run(SMOKE_CAPTION, { lyrics: '[Instrumental]', duration: SMOKE_DURATION_S })
  for await (const item of response.iterate()) {
    if (!item.outputArray) continue
    if (item.sampleRate != null) sampleRate = item.sampleRate
    if (item.channels != null) channels = item.channels
    chunks.push(Buffer.from(item.outputArray.buffer.slice(
      item.outputArray.byteOffset,
      item.outputArray.byteOffset + item.outputArray.byteLength)))
  }
  await response.await()
  const elapsedMs = Date.now() - t0

  await gen.destroy()

  const pcm = Buffer.concat(chunks)
  const totalSamples = pcm.length / 2
  const durationS = totalSamples / channels / sampleRate

  if (totalSamples <= 0) throw new Error('generation produced no audio samples')

  // The runner's playAudio() expects a base64 WAV string, which it writes to a
  // temp .wav and plays through the device speaker. Also persist a copy so we
  // can retrieve the exact on-device render afterwards.
  const wav = _pcmToWav(pcm, sampleRate, channels)
  _persistWav(modelDir, wav)
  const audioData = wav.toString('base64')

  return {
    summary: { total: 1, passed: 1, failed: 0 },
    audioData,
    sampleRate,
    channels,
    fullText:
      'generated ' + durationS.toFixed(1) + 's (' + totalSamples + ' samples @ ' +
      sampleRate + ' Hz x' + channels + ') in ' + (elapsedMs / 1000).toFixed(1) + 's'
  }
}

module.exports = { testLoadModels, testGenerateMusic }
