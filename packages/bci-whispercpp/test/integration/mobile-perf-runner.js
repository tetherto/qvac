'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const BCIWhispercpp = require('../../index')
const { flattenSegments } = require('@qvac/bci-whispercpp/util')
const {
  detectPlatform,
  getTestPaths,
  getModelPath,
  isMobile,
  recordBciStats
} = require('./helpers.js')

const { platform } = detectPlatform()
const { manifest, getSamplePath } = getTestPaths()
const NUM_TRANSCRIPTIONS = 3
const NO_GPU = os.hasEnv('NO_GPU') && os.getEnv('NO_GPU') === 'true'

function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

async function runMobilePerfCase (t, opts) {
  const modelFile = opts.modelFile || 'ggml-bci-windowed.bin'
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

  const modelPath = getModelPath(modelFile)
  const embedderPath = path.join(path.dirname(modelPath), 'bci-embedder.bin')
  if (!fs.existsSync(modelPath) || !fs.existsSync(embedderPath)) {
    t.fail(modelLabel + ' model/embedder not found at ' + modelPath)
    return
  }
  if (!manifest.samples || manifest.samples.length === 0) {
    t.pass(modelLabel + ' ' + epLabel + ' skipped: no fixtures in manifest')
    return
  }

  const sample = manifest.samples[0]
  const samplePath = getSamplePath(sample.file)
  if (!fs.existsSync(samplePath)) {
    t.pass(modelLabel + ' ' + epLabel + ' skipped: fixture ' + sample.file + ' not found')
    return
  }

  console.log('\n' + '='.repeat(60))
  console.log('MOBILE PERF CASE ' + modelLabel + ' ' + epLabel)
  console.log('='.repeat(60))
  console.log(' Platform: ' + platform)
  console.log(' Model file: ' + modelFile)
  console.log(' Transcriptions: ' + NUM_TRANSCRIPTIONS)
  console.log(' useGPU: ' + useGPU)
  console.log('='.repeat(60) + '\n')

  let bci = null
  try {
    bci = new BCIWhispercpp({
      files: { model: modelPath, embedder: embedderPath },
      opts: { stats: true }
    }, {
      whisperConfig: { language: 'en', temperature: 0.0 },
      miscConfig: { caption_enabled: false },
      contextParams: { use_gpu: useGPU },
      ...(typeof sample.day_idx === 'number' ? { bciConfig: { day_idx: sample.day_idx } } : {})
    })

    const loadStart = getTimeMs()
    await bci.load()
    console.log('   Model loaded in ' + (getTimeMs() - loadStart).toFixed(0) + 'ms\n')

    let statsCount = 0
    let lastStats = null
    for (let run = 1; run <= NUM_TRANSCRIPTIONS; run++) {
      console.log('=== Transcription ' + run + '/' + NUM_TRANSCRIPTIONS + ' ===')
      const runStart = getTimeMs()
      const response = await bci.transcribeFile(samplePath)
      const output = await response.await()
      const runTime = getTimeMs() - runStart

      const segments = flattenSegments(output)
      const text = segments.map((s) => (s && s.text) || '').join('').trim()
      const jobStats = response.stats

      console.log('   Time: ' + runTime.toFixed(0) + 'ms  Text: "' + text.substring(0, 60) + '"')

      if (jobStats) {
        statsCount++
        lastStats = jobStats
        recordBciStats(modelLabel + ' ' + epLabel + ' mobile-perf run ' + run, jobStats, {
          wallMs: runTime,
          output: text
        })
      }
    }

    t.ok(statsCount >= NUM_TRANSCRIPTIONS, modelLabel + ' ' + epLabel + ' should receive stats for every run (got ' + statsCount + ')')

    // Backend identity assertions (mirror gpu-smoke): backendDevice 0=CPU/1=GPU,
    // backendId 0=CPU,1=Metal,2=CUDA,3=Vulkan,4=OpenCL,99=other.
    const probe = lastStats || {}
    const backendDevice = typeof probe.backendDevice === 'number' ? probe.backendDevice : null
    const backendId = typeof probe.backendId === 'number' ? probe.backendId : null
    console.log('   Backend stats: backendDevice=' + backendDevice + ' backendId=' + backendId)
    t.ok(backendDevice !== null, modelLabel + ' ' + epLabel + ' should report backendDevice in stats')

    if (useGPU && platform.startsWith('android')) {
      t.ok(backendId === 3 || backendId === 4,
        modelLabel + ' ' + epLabel + ' Android use_gpu=true should select Vulkan(3) or OpenCL(4); got ' + backendId)
    } else if (useGPU && platform.startsWith('ios')) {
      t.is(backendId, 1, modelLabel + ' ' + epLabel + ' iOS use_gpu=true should select Metal(1); got ' + backendId)
    }

    console.log('Mobile perf case ' + modelLabel + ' ' + epLabel + ' completed!\n')
  } finally {
    if (bci) {
      try { await bci.destroy() } catch (err) { console.log('   destroy error: ' + err.message) }
    }
  }
}

module.exports = { runMobilePerfCase }
