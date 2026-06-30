'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const process = require('bare-process')
const BCIWhispercpp = require('../../index')
const { flattenSegments } = require('@qvac/bci-whispercpp/util')
const {
  detectPlatform,
  getMobileAssetPath,
  isMobile,
  recordBciStats
} = require('./helpers.js')

const { platform } = detectPlatform()
const NUM_TRANSCRIPTIONS = 3
const NO_GPU = os.hasEnv('NO_GPU') && os.getEnv('NO_GPU') === 'true'

function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

function loadManifest () {
  const manifestPath = getMobileAssetPath('manifest.json')
  if (!fs.existsSync(manifestPath)) return { samples: [] }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (_) {
    return { samples: [] }
  }
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

  // Assets (model / embedder / fixtures) are bundled under the app cache dir and
  // resolved via global.assetPaths — not global.testDir. Skip-pass (don't fail)
  // if a required asset is genuinely absent so the benchmark never red-flags on
  // an asset-staging issue; the real coverage signal is whether stats were
  // produced below.
  const modelPath = getMobileAssetPath(modelFile)
  const embedderPath = getMobileAssetPath('bci-embedder.bin')
  if (!fs.existsSync(modelPath) || !fs.existsSync(embedderPath)) {
    t.pass(modelLabel + ' ' + epLabel + ' skipped: model/embedder asset not found (' + modelPath + ')')
    return
  }

  const manifest = loadManifest()
  if (!manifest.samples || manifest.samples.length === 0) {
    t.pass(modelLabel + ' ' + epLabel + ' skipped: no fixtures in manifest')
    return
  }
  const sample = manifest.samples[0]
  const samplePath = getMobileAssetPath(sample.file)
  if (!fs.existsSync(samplePath)) {
    t.pass(modelLabel + ' ' + epLabel + ' skipped: fixture ' + sample.file + ' not found')
    return
  }

  console.log('\n' + '='.repeat(60))
  console.log('MOBILE PERF CASE ' + modelLabel + ' ' + epLabel)
  console.log('='.repeat(60))
  console.log(' Platform: ' + platform)
  console.log(' Model: ' + modelPath)
  console.log(' Fixture: ' + samplePath)
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

    // The benchmark's job is to COLLECT throughput, not to gate on which backend
    // the engine selected (that is gpu-smoke.test.js's responsibility). Backend
    // ids are logged for the report but not asserted, so a legitimate GPU->CPU
    // fallback doesn't turn the benchmark red.
    const probe = lastStats || {}
    console.log('   Backend stats: backendDevice=' +
      (typeof probe.backendDevice === 'number' ? probe.backendDevice : 'n/a') +
      ' backendId=' + (typeof probe.backendId === 'number' ? probe.backendId : 'n/a'))

    t.ok(statsCount > 0, modelLabel + ' ' + epLabel + ' should produce runtime stats for at least one run (got ' + statsCount + ')')
    console.log('Mobile perf case ' + modelLabel + ' ' + epLabel + ' completed (' + statsCount + '/' + NUM_TRANSCRIPTIONS + ' runs with stats)\n')
  } finally {
    if (bci) {
      try { await bci.destroy() } catch (err) { console.log('   destroy error: ' + err.message) }
    }
  }
}

module.exports = { runMobilePerfCase }
