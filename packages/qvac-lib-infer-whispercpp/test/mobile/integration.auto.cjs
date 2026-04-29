'use strict'
require('./integration-runtime.cjs')

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
} = require('../integration/helpers.js')

/* global runIntegrationModule */

async function runAccuracyMultilangTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/accuracy-multilang.test.js', options)
}

async function runAudioCtxChunkingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/audio-ctx-chunking.test.js', options)
}

async function runColdStartTimingTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/cold-start-timing.test.js', options)
}

async function runCorruptedModelTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/corrupted-model.test.js', options)
}

async function runLiveStreamSimulationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/live-stream-simulation.test.js', options)
}

async function runLongEsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/longES.test.js', options)
}

async function runModelFileValidationTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/model-file-validation.test.js', options)
}

async function runMultipleTranscriptionsTest (options = {}) { // eslint-disable-line no-unused-vars
  return runIntegrationModule('../integration/multiple-transcriptions.test.js', options)
}

function stats (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return sorted.length ? sum / sorted.length : 0
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
    device: { name: platform + '-' + arch, platform, os_version: '', arch, runner: 'device-farm' },
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

async function runRtfBenchmarkTest (options = {}) { // eslint-disable-line no-unused-vars
  const modelFile = 'ggml-tiny.bin'
  const { modelsDir } = getTestPaths()
  const modelPath = path.join(modelsDir, modelFile)
  const useGPU = isMobile
  const runCount = 3

  await ensureWhisperModel(modelPath)
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
    wallMs: Math.round(stats(runs.map(run => run.wallMs))),
    rtf: stats(runs.map(run => run.rtf)),
    tps: stats(runs.map(run => run.tps)),
    encoderMs: stats(runs.map(run => run.encoderMs).filter(value => value !== null)),
    decoderMs: stats(runs.map(run => run.decoderMs).filter(value => value !== null)),
    audioMs: Math.round(stats(runs.map(run => run.audioMs).filter(value => value !== null)))
  }

  emitPerfReport(summary, runs, modelFile, useGPU)
  console.log('Mobile Whisper RTF benchmark summary: ' + JSON.stringify(summary))
}
