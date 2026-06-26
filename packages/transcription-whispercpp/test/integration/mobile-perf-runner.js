'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TranscriptionWhispercpp = require('../../index.js')
const binding = require('../../binding')
const {
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  getAssetPath,
  ensureWhisperModel,
  createAudioStream,
  isMobile,
  recordWhisperStats
} = require('./helpers.js')

const platform = detectPlatform()
const { modelsDir } = getTestPaths()
const NUM_TRANSCRIPTIONS = 3
const SAMPLE_RATE = 16000
const NO_GPU = proc.env && proc.env.NO_GPU === 'true'

function getTimeMs () {
  const [sec, nsec] = proc.hrtime()
  return sec * 1000 + nsec / 1e6
}

function locateSampleAudio () {
  const candidates = ['sample.raw', 'short_en.raw']
  for (const name of candidates) {
    try {
      const samplePath = getAssetPath(name)
      if (samplePath && fs.existsSync(samplePath)) return samplePath
    } catch (_) {
      // Asset manifest may not contain this name on mobile — try next candidate.
    }
  }
  return null
}

async function ensureMobileModel (t, modelFile) {
  const modelPath = path.join(modelsDir, modelFile)
  const result = await ensureWhisperModel(modelPath)
  if (result && result.success) return modelPath
  t.fail('Failed to ensure whisper model: ' + modelFile)
  return null
}

async function runMobilePerfCase (t, opts) {
  const modelFile = opts.modelFile || 'ggml-tiny.bin'
  const useGPU = opts.useGPU
  const epLabel = useGPU ? '[GPU]' : '[CPU]'
  const modelLabel = '[' + modelFile.replace(/\.bin$/, '') + ']'

  if (!isMobile) {
    t.pass(modelLabel + ' ' + epLabel + ' mobile perf case skipped on desktop')
    return
  }

  if (useGPU && NO_GPU) {
    t.pass(modelLabel + ' ' + epLabel + ' mobile perf GPU case skipped (NO_GPU=true)')
    return
  }

  const loggerBinding = setupJsLogger(binding)
  let model = null

  try {
    console.log('\n' + '='.repeat(60))
    console.log('MOBILE PERF CASE ' + modelLabel + ' ' + epLabel)
    console.log('='.repeat(60))
    console.log(' Platform: ' + platform)
    console.log(' Model file: ' + modelFile)
    console.log(' Number of transcriptions: ' + NUM_TRANSCRIPTIONS)
    console.log(' useGPU: ' + useGPU)
    console.log('='.repeat(60) + '\n')

    const modelPath = await ensureMobileModel(t, modelFile)
    if (!modelPath) return
    console.log(' Model path: ' + modelPath)

    const samplePath = locateSampleAudio()
    if (!samplePath) {
      t.pass('Test skipped - sample audio not found via getAssetPath')
      return
    }
    const rawBuffer = fs.readFileSync(samplePath)
    const audioDurationSec = rawBuffer.length / 2 / SAMPLE_RATE
    console.log('   Audio path: ' + samplePath)
    console.log('   Audio duration: ' + audioDurationSec.toFixed(2) + 's\n')

    const constructorArgs = {
      files: { model: modelPath },
      opts: { stats: true }
    }

    const config = {
      path: modelPath,
      contextParams: {
        use_gpu: useGPU
      },
      whisperConfig: {
        language: 'en',
        audio_format: 's16le',
        temperature: 0.0,
        n_threads: 4
      }
    }

    const loadStart = getTimeMs()
    model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()
    console.log('   Model loaded in ' + (getTimeMs() - loadStart).toFixed(0) + 'ms\n')

    const timings = []
    let statsCount = 0
    let lastStats = null
    for (let run = 1; run <= NUM_TRANSCRIPTIONS; run++) {
      console.log('=== Transcription ' + run + '/' + NUM_TRANSCRIPTIONS + ' ===')
      const runStartTime = getTimeMs()

      const audioStream = createAudioStream(samplePath)
      const response = await model.run(audioStream)
      await response.await()

      const runTime = getTimeMs() - runStartTime
      timings.push(runTime)

      const jobStats = response.stats
      const segments = Array.isArray(response.segments) ? response.segments : []
      const runText = segments.map(s => (s && s.text) || '').join(' ').trim()

      console.log('   Time: ' + runTime.toFixed(0) + 'ms')
      console.log('   Segments: ' + segments.length)
      console.log('   Text preview: "' + runText.substring(0, 80) + (runText.length > 80 ? '...' : '') + '"')

      if (jobStats) {
        statsCount++
        lastStats = jobStats
        recordWhisperStats(modelLabel + ' ' + epLabel + ' mobile-perf run ' + run, jobStats, {
          wallMs: runTime,
          output: runText
        })
        if (typeof jobStats.realTimeFactor === 'number') {
          console.log('   RTF: ' + jobStats.realTimeFactor.toFixed(4))
        }
      }
      console.log('')
    }

    t.ok(statsCount >= NUM_TRANSCRIPTIONS, modelLabel + ' ' + epLabel + ' should receive stats for every run (got ' + statsCount + ')')
    t.ok(timings.length === NUM_TRANSCRIPTIONS, modelLabel + ' ' + epLabel + ' should complete ' + NUM_TRANSCRIPTIONS + ' transcriptions (got ' + timings.length + ')')

    // Backend identity assertions. `backendDevice` (0=CPU / 1=GPU) and
    // `backendId` (BackendId enum) are populated once per load() by
    // `WhisperModel::captureActiveBackendInfo()` and reported in every
    // stats snapshot — see index.d.ts BackendId.
    //   0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL, 99 = other
    // (kept in lock-step with transcription-parakeet's BackendId).
    // gpuMemTotalMb / gpuMemFreeMb report -1 when the device does not
    // expose memory accounting (some Vulkan ICDs on Apple silicon).
    const probe = lastStats || {}
    const backendDevice = typeof probe.backendDevice === 'number' ? probe.backendDevice : null
    const backendId = typeof probe.backendId === 'number' ? probe.backendId : null
    const gpuMemTotalMb = typeof probe.gpuMemTotalMb === 'number' ? probe.gpuMemTotalMb : -1
    const gpuMemFreeMb = typeof probe.gpuMemFreeMb === 'number' ? probe.gpuMemFreeMb : -1
    console.log('   Backend stats: backendDevice=' + backendDevice +
                ' backendId=' + backendId +
                ' gpuMemTotalMb=' + gpuMemTotalMb +
                ' gpuMemFreeMb=' + gpuMemFreeMb)

    t.ok(backendDevice !== null,
      modelLabel + ' ' + epLabel + ' should report backendDevice in runtimeStats')
    t.ok(backendId !== null,
      modelLabel + ' ' + epLabel + ' should report backendId in runtimeStats')

    if (useGPU && platform.startsWith('android')) {
      // On Android with use_gpu=true we expect ggml to have registered
      // Vulkan and/or OpenCL via the dynamic-backend `.so` files staged
      // next to the .bare module (BACKEND_DL_LOOSE_SOS in CMakeLists).
      // Device farm matrix: Pixel 9 (Mali) -> Vulkan (3),
      //                     Samsung S25 (Adreno) -> OpenCL (4).
      // Both backends register a GPU device, so asserting the union
      // (3 or 4) covers both device families without needing a per-
      // device-id branch from the bare-side test (the device farm
      // capability that distinguishes Pixel from Samsung lives in the
      // wdio config, not in the spec body). Per-device QLOG output
      // is in the device-farm logcat capture for review.
      t.ok(backendId === 3 || backendId === 4,
        modelLabel + ' ' + epLabel + ' Android with use_gpu=true should select a GPU backend (Vulkan=3 or OpenCL=4); got ' + backendId)
    } else if (useGPU && platform.startsWith('ios')) {
      // On iOS with use_gpu=true we expect ggml to have registered the
      // Metal backend (backendId 1). Metal ships inside the statically
      // linked `ggml-speech` (metal is a default-feature of that port on
      // osx | ios and is re-asserted by whisper-cpp[metal] in vcpkg.json),
      // so unlike Android there is no loose dynamic-backend `.so` to stage
      // — the backend is present in the .bare module itself. This is the
      // device-farm guard that iOS actually offloads to Metal (and that
      // the historical MTLCompiler XPC init crash has not regressed)
      // rather than silently falling back to CPU.
      t.is(backendId, 1,
        modelLabel + ' ' + epLabel + ' iOS with use_gpu=true should select the Metal backend (backendId=1); got ' + backendId)
    }

    console.log('Mobile perf case ' + modelLabel + ' ' + epLabel + ' completed successfully!\n')
  } finally {
    console.log('=== Cleanup ===')
    if (model) {
      try {
        if (typeof model.destroy === 'function') {
          await model.destroy()
        } else if (typeof model.dispose === 'function') {
          await model.dispose()
        }
        console.log('   Instance destroyed')
      } catch (err) {
        console.log('   Instance destroy error: ' + err.message)
      }
    }
    try {
      loggerBinding.releaseLogger()
      console.log('   Logger released')
    } catch (err) {
      console.log('   Logger release error: ' + err.message)
    }
  }
}

module.exports = {
  runMobilePerfCase
}
