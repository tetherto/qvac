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
// The turbo-q4 ACE-Step GGUFs (~3 GB) are too large to bundle in testAssets, so
// the tests fetch them from the QVAC model registry on-device at runtime into
// `<testDir>/models/` (same client the desktop suite uses). A pre-side-loaded
// set under `<testDir>/models` or `$AUDIOGEN_MODEL_DIR` is used as-is if present.

const fs = require('bare-fs')
const path = require('bare-path')
// Import by package name: on device this file is flattened into the runner's
// backend.cjs, so a relative require('..') would not resolve to the addon. The
// addon re-exports the model manifest helpers from models.js, so we get the
// registry paths + filenames without a second (possibly unresolved) require.
const {
  AudioGen,
  modelManifest,
  modelFilenames,
  REGISTRY_SOURCE,
  DEFAULT_DIT_VARIANT
} = require('@qvac/audiogen-ggml')

// Smoke uses the smallest/fastest DiT (turbo-q4): 3 fixed stages + turbo-q4 DiT.
const SMOKE_VARIANT = DEFAULT_DIT_VARIANT

// Turbo profile: fast 8-step schedule, short clip -> keeps on-device wall time
// and peak RAM bounded for a smoke run.
const TURBO_STEPS = 8
const TURBO_SHIFT = 3.0
const SMOKE_DURATION_S = 10
const SMOKE_CAPTION = 'Upbeat pop rock with driving electric guitars, punchy drums and a catchy hook'

// The four turbo-q4 stage filenames the smoke needs on disk.
function _stageFilenames () {
  const f = modelFilenames(SMOKE_VARIANT)
  return [f.textEnc, f.lm, f.dit, f.vae]
}

function _fileOk (p) {
  try {
    return fs.statSync(p).size > 0
  } catch (_e) {
    return false
  }
}

// Minimum plausible size for an ACE-Step stage GGUF. The smallest stage (VAE) is
// a few hundred MB, so a 16 MB floor cheaply rejects an empty / grossly-truncated
// download or an HTML error body. Partial truncations ABOVE the floor are caught
// by the native GGUF load (see _loadGenWithRetry), the authoritative check.
const _MIN_GGUF_BYTES = 16 * 1024 * 1024

// First 4 bytes of the file, or null if they can't be read (e.g. the runtime
// lacks partial reads) so the caller falls back to size + the load check.
function _ggufMagic (p) {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(4)
      fs.readSync(fd, buf, 0, 4, 0)
      return buf.toString('latin1')
    } finally {
      fs.closeSync(fd)
    }
  } catch (_e) {
    return null
  }
}

// A file large enough to be a real stage GGUF and starting with the GGUF magic.
// Catches the "download reported success but the file is empty / truncated at the
// start / an error page" cases that a bare `size > 0` misses.
function _ggufOk (p) {
  let size
  try { size = fs.statSync(p).size } catch (_e) { return false }
  if (size < _MIN_GGUF_BYTES) return false
  const magic = _ggufMagic(p)
  return magic === null || magic === 'GGUF'
}

function _hasAllStages (dir) {
  return _stageFilenames().every((name) => _ggufOk(path.join(dir, name)))
}

// Candidate dirs that may already hold a side-loaded model set, in order.
function _candidateDirs () {
  const candidates = []
  try {
    if (typeof process !== 'undefined' && process.env && process.env.AUDIOGEN_MODEL_DIR) {
      candidates.push(process.env.AUDIOGEN_MODEL_DIR)
    }
  } catch (_e) {}
  if (global.testDir) candidates.push(path.join(global.testDir, 'models'))
  if (typeof dirPath === 'string' && dirPath) candidates.push(path.join(dirPath, 'models'))
  return candidates
}

// The dir _ensureModels downloads into. Distinct from a user-supplied side-load
// ($AUDIOGEN_MODEL_DIR / dirPath), so the retry logic never deletes hand-staged files.
function _downloadDir () {
  const base = (global.testDir || (typeof dirPath === 'string' && dirPath)) || '.'
  return path.join(base, 'models')
}

// Resolve the model dir: use a complete side-loaded set if present, otherwise
// download the turbo-q4 GGUFs from the registry into `<testDir>/models`.
async function _ensureModels () {
  for (const dir of _candidateDirs()) {
    if (dir && _hasAllStages(dir)) {
      console.log('[audiogen-mobile] using models in ' + dir)
      return dir
    }
  }

  const outDir = _downloadDir()
  fs.mkdirSync(outDir, { recursive: true })

  let QVACRegistryClient
  try {
    ;({ QVACRegistryClient } = require('@qvac/registry-client'))
  } catch (e) {
    throw new Error(
      'ACE-Step models not present and @qvac/registry-client is unavailable on ' +
      'device to fetch them: ' + (e && e.message)
    )
  }

  const files = modelFilenames(SMOKE_VARIANT)
  const manifest = modelManifest(SMOKE_VARIANT)
  const entries = [
    { name: files.textEnc, registryPath: manifest.textEnc },
    { name: files.lm, registryPath: manifest.lm },
    { name: files.dit, registryPath: manifest.dit },
    { name: files.vae, registryPath: manifest.vae }
  ]

  console.log('[audiogen-mobile] downloading turbo-q4 GGUFs into ' + outDir)
  const client = new QVACRegistryClient()
  try {
    await client.ready()
    for (const entry of entries) {
      const dest = path.join(outDir, entry.name)
      if (_ggufOk(dest)) {
        console.log('[audiogen-mobile]   [ok] ' + entry.name + ' (cached)')
        continue
      }
      // Re-download (up to 3x) until the file is a valid GGUF. The registry client
      // can report "downloaded successfully" for a file that is truncated / corrupt
      // on a flaky transfer, so validate every download instead of trusting it.
      let ok = false
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try { fs.unlinkSync(dest) } catch (_e) {}
        const t0 = Date.now()
        await client.downloadModel(entry.registryPath, REGISTRY_SOURCE, {
          outputFile: dest,
          timeout: 1800000
        })
        ok = _ggufOk(dest)
        let size = 0
        try { size = fs.statSync(dest).size } catch (_e) {}
        console.log('[audiogen-mobile]   ' + (ok ? '[ok]' : '[bad ' + attempt + '/3]') + ' ' +
          entry.name + ' (' + size + ' bytes, ' + (Date.now() - t0) + ' ms)')
      }
      if (!ok) {
        throw new Error('failed to download a valid ' + entry.name + ' after 3 attempts')
      }
    }
  } finally {
    try {
      await client.close()
    } catch (_e) {}
  }

  if (!_hasAllStages(outDir)) {
    throw new Error('ACE-Step model download incomplete in ' + outDir)
  }
  return outDir
}

function _findGguf (dir, needle) {
  const hit = fs.readdirSync(dir).find((f) =>
    f.toLowerCase().includes(needle) && f.toLowerCase().endsWith('.gguf'))
  return hit ? path.join(dir, hit) : undefined
}

function _makeGen (modelDir, useGPU = false) {
  return new AudioGen({
    files: {
      modelDir,
      ditModel: _findGguf(modelDir, 'turbo')
    },
    config: {
      inferenceSteps: TURBO_STEPS,
      shift: TURBO_SHIFT,
      useGPU
    }
  })
}

// Delete the downloaded stage GGUFs so the next _ensureModels re-fetches them.
function _clearStages (dir) {
  for (const name of _stageFilenames()) {
    try { fs.unlinkSync(path.join(dir, name)) } catch (_e) {}
  }
}

// Ensure the models are present AND actually loadable. The native GGUF loader is
// the authoritative integrity check: a download can pass _ggufOk (right magic,
// big enough) yet be truncated mid-data, which only surfaces as a load failure
// ("failed to load VAE GGUF" / "DiT load failed"). On such a failure we wipe the
// models and re-download once more before giving up, so a flaky transfer doesn't
// fail the run. Returns the loaded generator + its model dir.
async function _loadGenWithRetry (maxAttempts = 3, useGPU = false) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const modelDir = await _ensureModels()
    const gen = _makeGen(modelDir, useGPU)
    try {
      await gen.load()
      return { gen, modelDir }
    } catch (e) {
      lastErr = e
      try { await gen.destroy() } catch (_e) {}
      // Only wipe + re-download the dir WE downloaded into — never a user's
      // side-loaded set ($AUDIOGEN_MODEL_DIR / dirPath), which we must not delete.
      if (modelDir === _downloadDir()) {
        console.log('[audiogen-mobile] load attempt ' + attempt + '/' + maxAttempts +
          ' failed (' + (e && e.message) + '); clearing models for a clean re-download')
        _clearStages(modelDir)
      } else {
        console.log('[audiogen-mobile] load attempt ' + attempt + '/' + maxAttempts +
          ' failed (' + (e && e.message) + ') on a side-loaded dir; not clearing it')
      }
    }
  }
  throw new Error('ACE-Step model load failed after ' + maxAttempts +
    ' attempts (last: ' + (lastErr && lastErr.message) + ')')
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
  const t0 = Date.now()
  const { gen, modelDir } = await _loadGenWithRetry()
  const loadMs = Date.now() - t0
  console.log('[audiogen-mobile] model dir: ' + modelDir)
  console.log('[audiogen-mobile] files: ' + fs.readdirSync(modelDir).join(', '))
  await gen.destroy()

  return {
    summary: { total: 1, passed: 1, failed: 0 },
    fullText: 'ACE-Step models ensured + loaded + freed in ' + loadMs + ' ms'
  }
}

function _pcmEnergy (pcm) {
  if (pcm.length % 2 !== 0) {
    throw new Error('PCM buffer length must be a multiple of 2 bytes (Int16), got ' + pcm.length)
  }
  let peak = 0
  let sumSquares = 0
  const samples = pcm.length / 2
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset) / 32768
    const abs = Math.abs(value)
    if (abs > peak) peak = abs
    sumSquares += value * value
  }
  return { peak, rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0 }
}

// End-to-end generation of a short turbo clip. Returns interleaved Int16 PCM so
// the runner can play it back on device. The Android GPU variant additionally
// requires the resolved backend to be Vulkan and rejects silent output.
async function _testGenerateMusic (useGPU) {
  const { gen, modelDir } = await _loadGenWithRetry(3, useGPU)

  const chunks = []
  let sampleRate = 48000
  let channels = 2

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
  const stats = await response.await()
  const elapsedMs = Date.now() - t0

  await gen.destroy()

  const pcm = Buffer.concat(chunks)
  const totalSamples = pcm.length / 2
  const durationS = totalSamples / channels / sampleRate
  const energy = _pcmEnergy(pcm)

  if (totalSamples <= 0) throw new Error('generation produced no audio samples')
  if (sampleRate !== 48000) throw new Error('expected 48 kHz output, got ' + sampleRate)
  if (channels !== 2) throw new Error('expected stereo output, got ' + channels + ' channels')
  if (energy.peak <= 0.1 || energy.rms <= 0.005) {
    throw new Error(
      'generation produced silent or invalid audio (peak=' + energy.peak.toFixed(4) +
      ', rms=' + energy.rms.toFixed(5) + ')')
  }
  if (useGPU) {
    const backendDevice = stats && stats.backendDevice
    const backendId = stats && stats.backendId
    console.log('[audiogen/GPU] backendDevice=' + backendDevice +
      ' backendId=' + backendId + (backendId === 3 ? ' (Vulkan)' : ''))
    if (backendDevice !== 1 || backendId !== 3) {
      throw new Error(
        'useGPU:true must run on Vulkan (backendDevice=1, backendId=3); got ' +
        backendDevice + '/' + backendId)
    }
  }

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
      (useGPU ? 'Vulkan GPU' : 'CPU') + ' generated ' + durationS.toFixed(1) +
      's (' + totalSamples + ' samples @ ' + sampleRate + ' Hz x' + channels +
      ', peak=' + energy.peak.toFixed(4) + ', rms=' + energy.rms.toFixed(5) +
      ') in ' + (elapsedMs / 1000).toFixed(1) + 's'
  }
}

async function testGenerateMusic () {
  return _testGenerateMusic(false)
}

async function testGenerateMusicOnGpu () {
  return _testGenerateMusic(true)
}

module.exports = { testLoadModels, testGenerateMusic, testGenerateMusicOnGpu }
