'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const {
  binding,
  ParakeetInterface,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureModelForType,
  getNamedPathsConfig,
  isMobile,
  recordParakeetStats
} = require('./helpers.js')

const platform = detectPlatform()
const { samplesDir } = getTestPaths()
const NUM_TRANSCRIPTIONS = 3

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
  const modelType = opts.modelType
  const useGPU = opts.useGPU
  const epLabel = useGPU ? '[GPU]' : '[CPU]'
  const modelLabel = `[${modelType}]`

  if (!isMobile) {
    t.pass(`${modelLabel} ${epLabel} mobile perf case skipped on desktop`)
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
    console.log(` Number of transcriptions: ${NUM_TRANSCRIPTIONS}`)
    console.log(` useGPU: ${useGPU}`)
    console.log('='.repeat(60) + '\n')

    const modelPath = await ensureModelForType(modelType)
    if (!modelPath) {
      t.fail(`Unable to resolve model for type: ${modelType}`)
      return
    }
    console.log(` Model path: ${modelPath}`)

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
        recordParakeetStats(`${modelLabel} ${epLabel} mobile-perf run ${run}`, jobStats, {
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
