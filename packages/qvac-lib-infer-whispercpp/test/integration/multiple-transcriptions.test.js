'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const TranscriptionWhispercpp = require('../../index')
const {
  ensureWhisperModel,
  getAssetPath,
  createAudioStream,
  isMobile,
  platform,
  recordWhisperStats
} = require('./helpers.js')

const ALL_DEVICE_CONFIGS = [
  { id: 'gpu', useGPU: true },
  { id: 'cpu', useGPU: false }
]
const CPU_ONLY_CONFIGS = ALL_DEVICE_CONFIGS.filter(c => c.id === 'cpu')
const TEST_OPTIONS_FILE = 'whisper-mobile-test-options.json'

function readJsonFile (filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    console.log('Failed to read ' + filePath + ': ' + err.message)
    return null
  }
}

function getWhisperMobileOptions () {
  if (!isMobile) return {}

  const candidates = []
  if (global.testDir) candidates.push(path.join(global.testDir, TEST_OPTIONS_FILE))
  if (platform === 'android') {
    candidates.push('/sdcard/Android/data/io.tether.test.qvac/files/' + TEST_OPTIONS_FILE)
    candidates.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files/' + TEST_OPTIONS_FILE)
  }
  candidates.push(path.join(os.tmpdir(), TEST_OPTIONS_FILE))

  for (const candidate of candidates) {
    const options = readJsonFile(candidate)
    if (options) {
      console.log('Loaded Whisper mobile test options from ' + candidate + ': ' + JSON.stringify(options))
      return options
    }
  }

  return {}
}

function getDeviceConfigs () {
  const options = getWhisperMobileOptions()
  if (options.whisperMobileMode === 'cpu-only') {
    console.log('Device Farm test spec requested CPU-only Whisper mobile coverage')
    return CPU_ONLY_CONFIGS
  }

  return isMobile ? ALL_DEVICE_CONFIGS : CPU_ONLY_CONFIGS
}

const DEVICE_CONFIGS = getDeviceConfigs()

function getExecutionProvider (useGPU) {
  if (!useGPU) return 'cpu'
  if (platform === 'ios') return 'coreml'
  if (platform === 'android') return 'nnapi'
  return 'gpu'
}

for (const deviceConfig of DEVICE_CONFIGS) {
  const epLabel = `[${deviceConfig.id.toUpperCase()}]`
  const executionProvider = getExecutionProvider(deviceConfig.useGPU)

  // On mobile, runs fewer transcriptions to avoid memory pressure.
  test(`Multiple consecutive transcriptions ${epLabel} should work without errors`, { timeout: 600000 }, async (t) => {
    const numTranscriptions = 3

    t.plan(3)

    const modelsDir = isMobile ? path.join(global.testDir || os.tmpdir(), 'models') : path.resolve(__dirname, '../../models')
    const modelPath = path.join(modelsDir, 'ggml-tiny.bin')

    // Create models directory if needed
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true })
    }

    const modelResult = await ensureWhisperModel(modelPath)
    if (!modelResult.success) {
      console.log('Model not available, skipping test')
      t.pass('Model not available')
      t.pass('Skipped')
      t.pass('Skipped')
      return
    }

    // Get audio path - uses getAssetPath for mobile compatibility
    let audioPath
    try {
      audioPath = getAssetPath('sample.raw')
    } catch (e) {
      console.log('Audio file not available, skipping test')
      t.pass('Audio not available')
      t.pass('Skipped')
      t.pass('Skipped')
      return
    }

    t.ok(fs.existsSync(modelPath), `${epLabel} Model file should exist`)
    t.ok(fs.existsSync(audioPath), `${epLabel} Audio file should exist`)

    const args = {
      files: {
        model: modelPath
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      opts: { stats: true }
    }

    const config = {
      path: modelPath,
      contextParams: {
        use_gpu: deviceConfig.useGPU,
        gpu_device: 0
      },
      whisperConfig: {
        language: 'en',
        audio_format: 's16le',
        temperature: 0.0
      }
    }

    let model
    try {
      model = new TranscriptionWhispercpp(args, config)
      await model.load()

      console.log(`\n=== Starting ${numTranscriptions} consecutive transcriptions ${epLabel} (${isMobile ? 'mobile' : 'desktop'}) ===\n`)
      console.log(`useGPU: ${deviceConfig.useGPU}`)

      for (let i = 0; i < numTranscriptions; i++) {
        console.log(`\n--- Transcription ${i + 1}/${numTranscriptions} ${epLabel} ---`)

        // Use createAudioStream helper to avoid fs.createReadStream bug
        const audioStream = createAudioStream(audioPath)
        const runStart = Date.now()
        const response = await model.run(audioStream)

        let transcriptText = ''
        await response.onUpdate((output) => {
          console.log('Transcription onUpdate:', output)
          if (Array.isArray(output)) {
            for (const segment of output) {
              if (segment.text) {
                transcriptText += segment.text
              }
            }
          }
        }).await()

        const runTime = Date.now() - runStart
        console.log(`Transcription ${i + 1} ${epLabel} completed`)
        console.log(`Time: ${runTime}ms`)
        console.log(`Text length: ${transcriptText.length}`)

        if (response.stats) {
          try {
            recordWhisperStats(`${epLabel} multi-transcribe run ${i + 1}`, response.stats, {
              wallMs: runTime,
              output: transcriptText,
              executionProvider,
              input: 'ggml-tiny.bin'
            })
          } catch (err) {
            console.log(`   [perf] recordWhisperStats failed: ${err.message}`)
          }
          if (typeof response.stats.realTimeFactor === 'number') {
            console.log(`RTF: ${response.stats.realTimeFactor.toFixed(4)}`)
          }
        }

        // Small delay between runs to allow memory cleanup
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      console.log(`\n=== All ${numTranscriptions} transcriptions ${epLabel} completed ===\n`)
      t.ok(true, `${epLabel} All transcriptions completed without errors`)
    } finally {
      if (model) {
        console.log('Calling model.unload()...')
        try {
          await model.unload()
          console.log('model.unload() completed')
        } catch (e) {
          console.log('model.unload() error:', e.message)
        }

        console.log('Calling model.destroy()...')
        try {
          await model.destroy()
          console.log('model.destroy() completed')
        } catch (e) {
          console.log('model.destroy() error:', e.message)
        }
      }
      console.log(`Test finished ${epLabel}`)
    }
  })
}
