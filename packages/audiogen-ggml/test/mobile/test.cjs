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
// Android Device Farm also pre-stages the same set under /data/local/tmp so the
// phone does not spend its per-test budget downloading ~3 GB over mobile Wi-Fi.

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
// Functional lane's on-device inference budget: 1 s of audio is enough to
// exercise the full load -> forward -> decode -> emit path once per backend
// without paying for a full listenable clip. The RTF benchmark lane runs its
// own longer schedule via @qvac/audiogen-ggml/test/benchmark-runner.
const SMOKE_DURATION_S = 1
const SMOKE_CAPTION =
  'Upbeat pop rock with driving electric guitars, punchy drums and a catchy hook'
const GPU_DEVICE = 1
const VULKAN_BACKEND = 3
const OPENCL_BACKEND = 4
const GPU_BACKEND_NAMES = {
  [VULKAN_BACKEND]: 'Vulkan',
  [OPENCL_BACKEND]: 'OpenCL'
}
const ANDROID_PRESTAGED_MODEL_DIR = '/data/local/tmp/prestaged-audiogen-models'

// The four stage filenames a variant needs on disk. Defaults to the smoke's
// turbo-q4; testRtfBenchmark passes the variant its matrix row asks for.
function _stageFilenames(variant = SMOKE_VARIANT) {
  const f = modelFilenames(variant)
  return [f.textEnc, f.lm, f.dit, f.vae]
}

function _fileOk(p) {
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
function _ggufMagic(p) {
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
function _ggufOk(p) {
  let size
  try {
    size = fs.statSync(p).size
  } catch (_e) {
    return false
  }
  if (size < _MIN_GGUF_BYTES) return false
  const magic = _ggufMagic(p)
  return magic === null || magic === 'GGUF'
}

function _hasAllStages(dir, variant = SMOKE_VARIANT) {
  return _stageFilenames(variant).every((name) => _ggufOk(path.join(dir, name)))
}

// Candidate dirs that may already hold a side-loaded model set, in order.
function _candidateDirs() {
  const candidates = []
  try {
    if (typeof process !== 'undefined' && process.env && process.env.AUDIOGEN_MODEL_DIR) {
      candidates.push(process.env.AUDIOGEN_MODEL_DIR)
    }
  } catch (_e) {}
  candidates.push(ANDROID_PRESTAGED_MODEL_DIR)
  if (global.testDir) candidates.push(path.join(global.testDir, 'models'))
  if (typeof dirPath === 'string' && dirPath) candidates.push(path.join(dirPath, 'models'))
  return candidates
}

// The dir _ensureModels downloads into. Distinct from a user-supplied side-load
// ($AUDIOGEN_MODEL_DIR / dirPath), so the retry logic never deletes hand-staged files.
function _downloadDir() {
  const base = global.testDir || (typeof dirPath === 'string' && dirPath) || '.'
  return path.join(base, 'models')
}

// Resolve the model dir: use a complete side-loaded set if present, otherwise
// download the variant's GGUFs from the registry into `<testDir>/models`.
async function _ensureModels(variant = SMOKE_VARIANT) {
  for (const dir of _candidateDirs()) {
    if (dir && _hasAllStages(dir, variant)) {
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
        'device to fetch them: ' +
        (e && e.message)
    )
  }

  const files = modelFilenames(variant)
  const manifest = modelManifest(variant)
  const entries = [
    { name: files.textEnc, registryPath: manifest.textEnc },
    { name: files.lm, registryPath: manifest.lm },
    { name: files.dit, registryPath: manifest.dit },
    { name: files.vae, registryPath: manifest.vae }
  ]

  console.log('[audiogen-mobile] downloading ' + variant + ' GGUFs into ' + outDir)
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
        try {
          fs.unlinkSync(dest)
        } catch (_e) {}
        const t0 = Date.now()
        await client.downloadModel(entry.registryPath, REGISTRY_SOURCE, {
          outputFile: dest,
          timeout: 1800000
        })
        ok = _ggufOk(dest)
        let size = 0
        try {
          size = fs.statSync(dest).size
        } catch (_e) {}
        console.log(
          '[audiogen-mobile]   ' +
            (ok ? '[ok]' : '[bad ' + attempt + '/3]') +
            ' ' +
            entry.name +
            ' (' +
            size +
            ' bytes, ' +
            (Date.now() - t0) +
            ' ms)'
        )
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

  if (!_hasAllStages(outDir, variant)) {
    throw new Error('ACE-Step model download incomplete in ' + outDir)
  }
  return outDir
}

function _findGguf(dir, needle) {
  const hit = fs
    .readdirSync(dir)
    .find((f) => f.toLowerCase().includes(needle) && f.toLowerCase().endsWith('.gguf'))
  return hit ? path.join(dir, hit) : undefined
}

function _makeGen(modelDir, useGPU = false) {
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
function _clearStages(dir, variant = SMOKE_VARIANT) {
  for (const name of _stageFilenames(variant)) {
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch (_e) {}
  }
}

// Ensure the models are present AND actually loadable. The native GGUF loader is
// the authoritative integrity check: a download can pass _ggufOk (right magic,
// big enough) yet be truncated mid-data, which only surfaces as a load failure
// ("failed to load VAE GGUF" / "DiT load failed"). On such a failure we wipe the
// models and re-download once more before giving up, so a flaky transfer doesn't
// fail the run. Returns the loaded generator + its model dir.
async function _loadGenWithRetry(maxAttempts = 3, useGPU = false) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const modelDir = await _ensureModels()
    const gen = _makeGen(modelDir, useGPU)
    try {
      await gen.load()
      return { gen, modelDir }
    } catch (e) {
      lastErr = e
      try {
        await gen.destroy()
      } catch (_e) {}
      // Only wipe + re-download the dir WE downloaded into — never a user's
      // side-loaded set ($AUDIOGEN_MODEL_DIR / dirPath), which we must not delete.
      if (modelDir === _downloadDir()) {
        console.log(
          '[audiogen-mobile] load attempt ' +
            attempt +
            '/' +
            maxAttempts +
            ' failed (' +
            (e && e.message) +
            '); clearing models for a clean re-download'
        )
        _clearStages(modelDir)
      } else {
        console.log(
          '[audiogen-mobile] load attempt ' +
            attempt +
            '/' +
            maxAttempts +
            ' failed (' +
            (e && e.message) +
            ') on a side-loaded dir; not clearing it'
        )
      }
    }
  }
  throw new Error(
    'ACE-Step model load failed after ' +
      maxAttempts +
      ' attempts (last: ' +
      (lastErr && lastErr.message) +
      ')'
  )
}

// Load every stage GGUF and tear down again — cheap smoke to isolate model
// load (I/O + parse + graph alloc) from full diffusion inference.
async function testLoadModels() {
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

function _requireGpuBackend(stats) {
  const backendDevice = stats && stats.backendDevice
  const backendId = stats && stats.backendId
  const backendName = GPU_BACKEND_NAMES[backendId]
  console.log(
    '[audiogen/GPU] backendDevice=' +
      backendDevice +
      ' backendId=' +
      backendId +
      (backendName ? ' (' + backendName + ')' : '')
  )
  if (backendDevice !== GPU_DEVICE || backendName === undefined) {
    throw new Error(
      'useGPU:true must run on Vulkan or OpenCL; got ' + backendDevice + '/' + backendId
    )
  }
  return backendName
}

// Load + minimal (1 s) generation smoke: proves the pipeline runs load -> forward
// -> decode -> emit on the target backend without crashing, without paying for a
// full listenable clip. The Android GPU variant additionally asserts the run
// actually engaged a supported GPU backend. Audio quality (energy floors), WAV
// persistence, and base64 playback payload are intentionally NOT part of this
// smoke — mobile CI does not need to hear the output, only that the pipeline
// completed.
async function _testGenerateMusic(useGPU) {
  const { gen } = await _loadGenWithRetry(3, useGPU)

  const chunks = []
  let sampleRate = 48000
  let channels = 2

  const t0 = Date.now()
  // run() returns a @qvac/infer-base QvacResponse: iterate() streams progress
  // ticks + the interleaved-Int16 PCM chunk(s); await() resolves the run stats.
  const response = await gen.run(SMOKE_CAPTION, {
    lyrics: '[Instrumental]',
    duration: SMOKE_DURATION_S
  })
  for await (const item of response.iterate()) {
    if (!item.outputArray) continue
    if (item.sampleRate != null) sampleRate = item.sampleRate
    if (item.channels != null) channels = item.channels
    chunks.push(
      Buffer.from(
        item.outputArray.buffer.slice(
          item.outputArray.byteOffset,
          item.outputArray.byteOffset + item.outputArray.byteLength
        )
      )
    )
  }
  const stats = await response.await()
  const elapsedMs = Date.now() - t0

  await gen.destroy()

  const pcm = Buffer.concat(chunks)
  const totalSamples = pcm.length / 2
  const durationS = totalSamples / channels / sampleRate

  if (totalSamples <= 0) throw new Error('generation produced no audio samples')
  if (sampleRate !== 48000) throw new Error('expected 48 kHz output, got ' + sampleRate)
  if (channels !== 2) throw new Error('expected stereo output, got ' + channels + ' channels')
  const executionTarget = useGPU ? _requireGpuBackend(stats) + ' GPU' : 'CPU'

  return {
    summary: { total: 1, passed: 1, failed: 0 },
    sampleRate,
    channels,
    fullText:
      executionTarget +
      ' generated ' +
      durationS.toFixed(1) +
      's (' +
      totalSamples +
      ' samples @ ' +
      sampleRate +
      ' Hz x' +
      channels +
      ') in ' +
      (elapsedMs / 1000).toFixed(1) +
      's'
  }
}

// --- RTF benchmark -------------------------------------------------------
//
// Only benchmark runs execute this: it is listed in perf-tests.json, not in
// test-groups.json, so normal PR runs never pay for it. The workflow selects the
// DiT variant / GPU flag by pushing QVAC_AUDIOGEN_GGML_BENCHMARK_* to the device
// (the mobile action's `extra-device-env` input, which os.setEnv()s each key
// before the tests load), so one Device Farm row = one benchmark configuration.

// How many times to redo the whole benchmark after a model-load failure. A
// download can pass _ggufOk (right magic, big enough) yet be truncated mid-data,
// which only surfaces when the native loader parses it; wipe and re-fetch once
// before giving up rather than losing the row to a flaky transfer.
const _BENCHMARK_LOAD_ATTEMPTS = 2

// Reached by package subpath for the same reason as the addon import above, and
// required lazily so that if it fails to resolve on a device only the benchmark
// row fails — the functional smoke above must stay unaffected. This is the same
// measurement the desktop RTF benchmark runs, so the two lanes cannot drift.
function _benchmarkRunner() {
  return require('@qvac/audiogen-ggml/test/benchmark-runner')
}

// A rejected measurement is a real result, not a bad download: re-fetching ~3 GB
// would not change it.
function _isLoadFailure(err) {
  if (err && err.name === 'BenchmarkResultError') return false
  const message = (err && err.message) || ''
  return /load|gguf|model/i.test(message)
}

// Model resolution hook handed to the shared runner: reuses the smoke's
// validating downloader instead of the desktop registry helper, so the
// benchmark gets the same GGUF integrity checks and per-file retries.
function _benchmarkEnsureModels(settings) {
  return _ensureModels(settings.ditVariant)
}

async function _runBenchmarkWithRetry(runRtfBenchmark, settings) {
  let lastErr
  for (let attempt = 1; attempt <= _BENCHMARK_LOAD_ATTEMPTS; attempt++) {
    try {
      return await runRtfBenchmark(settings, { ensureModels: _benchmarkEnsureModels })
    } catch (e) {
      lastErr = e
      if (attempt === _BENCHMARK_LOAD_ATTEMPTS || !_isLoadFailure(e)) throw e
      console.log(
        '[audiogen-mobile] benchmark attempt ' +
          attempt +
          '/' +
          _BENCHMARK_LOAD_ATTEMPTS +
          ' failed (' +
          (e && e.message) +
          '); clearing models for a clean re-download'
      )
      _clearStages(_downloadDir(), settings.ditVariant)
    }
  }
  throw lastErr
}

// On-device RTF benchmark. Numbers leave the device through the
// [PERF_REPORT_START] / [PERF_CHUNK] markers the runner prints, which the
// workflow's extract-addon-perf step scrapes out of bare_console.log.
async function testRtfBenchmark() {
  const { readBenchmarkSettings, runRtfBenchmark, emitCanonicalReport, describeSummary } =
    _benchmarkRunner()

  const settings = readBenchmarkSettings()
  console.log(
    '[audiogen-mobile] RTF benchmark: ' +
      settings.ditVariant +
      ' useGPU=' +
      settings.useGPU +
      ' runs=' +
      settings.numRuns
  )

  const result = await _runBenchmarkWithRetry(runRtfBenchmark, settings)
  emitCanonicalReport(settings, result.summary, result.backend)

  return {
    summary: { total: 1, passed: 1, failed: 0 },
    fullText: describeSummary(settings, result.summary, result.backend)
  }
}

async function testGenerateMusicOnCpu() {
  return _testGenerateMusic(false)
}

async function testGenerateMusicOnGpu() {
  return _testGenerateMusic(true)
}

module.exports = {
  testLoadModels,
  testGenerateMusicOnCpu,
  testGenerateMusicOnGpu,
  testRtfBenchmark,
  _requireGpuBackend
}
