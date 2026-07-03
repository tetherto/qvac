'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const {
  binding,
  ParakeetInterface,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip,
  getNamedPathsConfig,
  isMobile,
  recordParakeetStats,
  quantFromGgufName
} = require('./helpers.js')

const platform = detectPlatform()
const { samplesDir } = getTestPaths()
const NUM_TRANSCRIPTIONS = 3
const NO_GPU = proc.env && proc.env.NO_GPU === 'true'
// Same escape hatch as gpu-smoke.test.js: downgrade a GPU-engagement failure
// to a warning instead of failing the run.
const RELAX = proc.env && proc.env.QVAC_PARAKEET_GPU_SMOKE_RELAX === '1'

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

// Assert the backend the engine actually resolved to for a perf run, instead
// of asserting nothing (the previous behaviour). Mirrors gpu-smoke.test.js's
// assertGpuBackend contract so the perf-GPU runner is no longer blind to a
// silent CPU fallback:
//   - useGPU=true  -> must engage GPU (backendDevice=1); on Android a GPU the
//     engine declines by policy (gpuUnsupported, backendDevice=0) is accepted
//     as correct, matching gpu-smoke. RELAX downgrades a hard failure.
//   - useGPU=false -> must resolve to CPU (backendDevice=0).
// NOTE: truly *exercising* GPU inference on Android still requires parakeet-cpp
// to stop forcing useGPU=false there; until then Android legitimately reports
// gpuUnsupported and runs on CPU. This assertion makes that state explicit and
// keeps iOS (Metal) strict.
function assertPerfBackend (t, label, useGPU, stats) {
  if (!stats) {
    t.fail(`${label} no JobEnded stats to verify backend`)
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  const name = backendIdToName(id)
  console.log(`${label} backendDevice=${dev} backendId=${id} (${name})`)

  if (!useGPU) {
    t.is(dev, 0, `${label} useGPU=false must resolve to CPU, got ${name}`)
    return
  }

  if (platform === 'android' && dev === 0 && stats.gpuUnsupported) {
    t.pass(`${label} GPU present but declined by policy (gpuUnsupported); correctly using CPU`)
    return
  }

  if (dev !== 1) {
    const msg = `${label} expected GPU backend, got ${name} (backendDevice=${dev}). ` +
                'useGPU=true was requested but the engine fell back to CPU.'
    if (RELAX) {
      t.comment(`WARNING (relaxed): ${msg}`)
      t.pass(`${label} perf backend check completed (relaxed)`)
    } else {
      t.fail(msg)
    }
    return
  }

  if (platform === 'ios') {
    t.is(id, 1, `${label} expected Metal backendId=1, got ${name}`)
  } else if (platform === 'android') {
    t.ok(id === 3 || id === 4, `${label} expected Vulkan(3) or OpenCL(4), got ${name}`)
  }
}

function loadSampleAudio () {
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) return null

  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }
  return audioData
}

async function runMobilePerfCase (t, opts) {
  if (!opts.quant) {
    await runMobilePerfCase(t, { ...opts, quant: 'q4_0' })
    await runMobilePerfCase(t, { ...opts, quant: 'q8_0' })
    await runMobilePerfCase(t, { ...opts, quant: 'f16' })
    return
  }

  const modelType = opts.modelType
  const useGPU = opts.useGPU
  const quant = opts.quant
  const epLabel = useGPU ? '[GPU]' : '[CPU]'
  const modelLabel = `[${modelType}]`

  if (!isMobile) {
    t.pass(`${modelLabel} ${epLabel} mobile perf case skipped on desktop`)
    return
  }

  if (useGPU && NO_GPU) {
    t.pass(`${modelLabel} ${epLabel} mobile perf GPU case skipped (NO_GPU=true)`)
    return
  }

  const loggerBinding = setupJsLogger(binding)
  let parakeet = null
  let outputResolve = null
  const allResults = []
  const receivedStats = []

  function finishCurrentRun () {
    if (outputResolve) {
      outputResolve()
      outputResolve = null
    }
  }

  try {
    console.log('\n' + '='.repeat(60))
    console.log(`MOBILE PERF CASE ${modelLabel} ${epLabel}`)
    console.log('='.repeat(60))
    console.log(` Platform: ${platform}`)
    console.log(` Model type: ${modelType}`)
    if (quant) console.log(` Requested quant: ${quant}`)
    console.log(` Number of transcriptions: ${NUM_TRANSCRIPTIONS}`)
    console.log(` useGPU: ${useGPU}`)
    console.log('='.repeat(60) + '\n')

    const modelPath = await loadGgufOrSkip(t, modelType, quant ? { quant } : {})
    if (!modelPath) return
    const resolvedQuant = quantFromGgufName(modelPath) || 'q4_0'
    const quantLabel = `[${resolvedQuant}]`
    console.log(` Model path: ${modelPath}`)
    console.log(` Quant: ${resolvedQuant}`)

    const audioData = loadSampleAudio()
    if (!audioData) {
      t.pass('Test skipped - sample audio not found')
      return
    }
    console.log(`   Audio duration: ${(audioData.length / 16000).toFixed(2)}s\n`)

    const config = {
      modelPath,
      modelType,
      maxThreads: 4,
      useGPU,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig(modelType, modelPath)
    }

    function outputCallback (handle, event, id, output, error) {
      if (event === 'Output' && Array.isArray(output)) {
        for (const segment of output) {
          if (segment && segment.text) {
            allResults.push({ jobId: id, segment })
          }
        }
      } else if (event === 'JobEnded' && output) {
        receivedStats.push({ jobId: id, stats: output })
        finishCurrentRun()
      } else if (event === 'Error' || error) {
        finishCurrentRun()
      }
    }

    parakeet = new ParakeetInterface(binding, config, outputCallback)
    await parakeet.activate()
    console.log('   Model activated\n')

    const timings = []
    for (let run = 1; run <= NUM_TRANSCRIPTIONS; run++) {
      console.log(`=== Transcription ${run}/${NUM_TRANSCRIPTIONS} ===`)
      const runStartTime = Date.now()
      const startResultCount = allResults.length
      const outputPromise = new Promise(resolve => { outputResolve = resolve })

      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      const timeout = setTimeout(finishCurrentRun, 600000)
      await outputPromise
      clearTimeout(timeout)

      const runTime = Date.now() - runStartTime
      timings.push(runTime)
      const runResults = allResults.slice(startResultCount)
      const runText = runResults.map(r => r.segment.text).join(' ').trim()

      console.log(`   Time: ${runTime}ms`)
      console.log(`   Segments: ${runResults.length}`)
      console.log(`   Text preview: "${runText.substring(0, 80)}${runText.length > 80 ? '...' : ''}"`)

      const jobStats = receivedStats.length > 0
        ? receivedStats[receivedStats.length - 1].stats
        : null
      if (jobStats) {
        recordParakeetStats(`${modelLabel} ${quantLabel} ${epLabel} mobile-perf run ${run}`, jobStats, {
          wallMs: runTime,
          output: runText
        })
        if (typeof jobStats.realTimeFactor === 'number') {
          console.log(`   RTF: ${jobStats.realTimeFactor.toFixed(4)}`)
        }
      }
      console.log('')
    }

    t.ok(receivedStats.length >= NUM_TRANSCRIPTIONS, `${modelLabel} ${epLabel} should receive JobEnded stats for every run (got ${receivedStats.length})`)
    t.ok(timings.length === NUM_TRANSCRIPTIONS, `${modelLabel} ${epLabel} should complete ${NUM_TRANSCRIPTIONS} transcriptions (got ${timings.length})`)

    // Verify the engine ran on the backend the case requested, instead of
    // asserting nothing about it (the previous gap called out in the ticket).
    const lastStats = receivedStats.length > 0
      ? receivedStats[receivedStats.length - 1].stats
      : null
    assertPerfBackend(t, `${modelLabel} ${epLabel}`, useGPU, lastStats)

    console.log(`✅ Mobile perf case ${modelLabel} ${epLabel} completed successfully!\n`)
  } finally {
    console.log('=== Cleanup ===')
    finishCurrentRun()
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
        console.log('   Instance destroyed')
      } catch (err) {
        console.log('   Instance destroy error:', err.message)
      }
    }
    try {
      loggerBinding.releaseLogger()
      console.log('   Logger released')
    } catch (err) {
      console.log('   Logger release error:', err.message)
    }
  }
}

module.exports = {
  runMobilePerfCase
}
