'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const {
  ensureWhisperModel,
  getAssetPath,
  getTestPaths,
  runTranscription,
  isMobile,
  platform,
  arch
} = require('./helpers.js')

function mean (values) {
  const nums = values.filter(value => value !== null && value !== undefined && !Number.isNaN(value))
  if (nums.length === 0) return null
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

function roundMaybe (value) {
  return value === null || value === undefined ? null : Math.round(value)
}

function writePerfReportToConsole (perfReport) {
  const json = JSON.stringify(perfReport)
  const chunkSize = 800
  if (json.length <= chunkSize) {
    console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
    return
  }

  const id = Date.now().toString(36)
  const chunkCount = Math.ceil(json.length / chunkSize)
  for (let i = 0; i < chunkCount; i++) {
    const chunk = json.substring(i * chunkSize, (i + 1) * chunkSize)
    console.log('[PERF_CHUNK:' + id + ':' + i + ':' + chunkCount + ']' + chunk)
  }
}

function writePerfReportToFiles (perfReport) {
  const dirs = []
  if (global.testDir) dirs.push(global.testDir)
  if (platform === 'android') {
    dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
    dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
    dirs.push('/data/local/tmp')
  }
  dirs.push('/tmp')

  const json = JSON.stringify(perfReport)
  for (const dir of dirs) {
    try {
      try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
      const reportPath = path.join(dir, 'perf-report.json')
      fs.writeFileSync(reportPath, json)
      console.log('[PERF_REPORT_PATH]' + reportPath)
    } catch (err) {
      console.log('[perf-reporter] write to ' + dir + ' failed: ' + err.message)
    }
  }
}

function emitPerfReport (summary, runs, modelFile, useGPU) {
  const backend = useGPU ? (platform === 'ios' ? 'coreml' : 'nnapi') : 'cpu'
  const perfReport = {
    schema_version: '1.0',
    addon: 'whispercpp',
    addon_type: 'whisper',
    timestamp: new Date().toISOString(),
    device: {
      name: platform + '-' + arch,
      platform,
      os_version: '',
      arch,
      runner: 'device-farm'
    },
    results: [{
      test: '[' + backend.toUpperCase() + '] ' + modelFile.replace(/\.bin$/, ''),
      execution_provider: backend,
      metrics: {
        total_time_ms: summary.wallMs,
        real_time_factor: summary.rtf,
        wall_time_ms: summary.wallMs,
        tps: summary.tps,
        encoder_time_ms: summary.encoderMs,
        decoder_time_ms: summary.decoderMs,
        audio_duration_ms: summary.audioMs,
        sample_count: runs.length
      },
      input: modelFile,
      output: null
    }]
  }

  writePerfReportToFiles(perfReport)
  writePerfReportToConsole(perfReport)
}

test('Mobile RTF benchmark should emit performance report', { timeout: 600000 }, async (t) => {
  const modelFile = 'ggml-tiny.bin'
  const { modelsDir } = getTestPaths()
  const modelPath = path.join(modelsDir, modelFile)
  const useGPU = isMobile
  const runCount = 3

  const modelResult = await ensureWhisperModel(modelPath)
  if (!modelResult.success) {
    throw new Error('Model not available: ' + (modelResult.error || modelPath))
  }

  const samplePath = getAssetPath('sample.raw')
  const runs = []

  for (let i = 0; i < runCount; i++) {
    const start = Date.now()
    const result = await runTranscription({
      modelPath,
      audioInput: samplePath,
      opts: { stats: true },
      contextParams: { use_gpu: useGPU, gpu_device: 0 },
      whisperConfig: { language: 'en', audio_format: 's16le', temperature: 0.0 }
    })
    const wallMs = Date.now() - start

    if (!result.passed) throw new Error(result.output)
    if (!result.data || !result.data.stats) throw new Error('Whisper response did not include runtime stats')

    const runStats = result.data.stats
    runs.push({
      wallMs,
      rtf: runStats.realTimeFactor || 0,
      tps: runStats.tokensPerSecond || 0,
      encoderMs: runStats.whisperEncodeMs || null,
      decoderMs: runStats.whisperDecodeMs || null,
      audioMs: runStats.audioDurationMs || null
    })
  }

  const summary = {
    wallMs: roundMaybe(mean(runs.map(run => run.wallMs))),
    rtf: mean(runs.map(run => run.rtf)),
    tps: mean(runs.map(run => run.tps)),
    encoderMs: roundMaybe(mean(runs.map(run => run.encoderMs))),
    decoderMs: roundMaybe(mean(runs.map(run => run.decoderMs))),
    audioMs: roundMaybe(mean(runs.map(run => run.audioMs)))
  }

  emitPerfReport(summary, runs, modelFile, useGPU)
  console.log('Mobile Whisper RTF benchmark summary: ' + JSON.stringify(summary))

  t.is(runs.length, runCount, 'completed configured benchmark runs')
  t.ok(summary.rtf > 0, 'mean RTF should be positive')
})
