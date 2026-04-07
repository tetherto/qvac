'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const TranscriptionWhispercpp = require('../index.js')
const FakeDL = require('../test/mocks/loader.fake.js')
const binding = require('../binding.js')

// Configure C++ logger to see logs
const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
binding.setLogger((priority, message) => {
  const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
  console.log(`[C++ ${priorityName}] ${message}`)
})

// Usage: node examples/quickstart.js [audioDir] [modelPath] [vadModelPath]
// Defaults stream ./examples/sample.raw through a tiny model in ./examples

async function main () {
  const args = process.argv.slice(2)
  const [, modelPathArg, vadModelPathArg, audioPathArg] = args

  const modelsDir = path.join(__dirname, '..', 'models')
  const audioFilePath = audioPathArg || path.join(__dirname, 'samples', 'sample.raw')
  const modelPath = vadModelPathArg || path.join(modelsDir, 'ggml-tiny.bin')
  // ignore optional vadModelPathArg to keep API stable

  if (!fs.existsSync(modelPath)) {
    console.error(`Model file not found at ${modelPath}. Download or provide a path as the second argument.`)
    process.exit(1)
  }
  if (!fs.existsSync(audioFilePath)) {
    console.error(`Audio file not found at ${audioFilePath}. Provide a directory containing sample.raw as the first argument.`)
    process.exit(1)
  }

  // Constructor arguments for TranscriptionWhispercpp
  const constructorArgs = {
    modelName: modelPathArg || 'ggml-tiny.bin',
    loader: new FakeDL({}),
    diskPath: modelsDir
  }

  // Configuration object
  const config = {
    opts: { stats: true },
    whisperConfig: {
      audio_format: 's16le',
      // VAD tuning to avoid trimming the beginning
      vad_model_path: path.join(modelsDir, 'ggml-silero-v5.1.2.bin'),
      vad_params: {
        threshold: 0.35,
        min_speech_duration_ms: 200,
        min_silence_duration_ms: 150,
        max_speech_duration_s: 30,
        speech_pad_ms: 600,
        samples_overlap: 0.3
      },
      language: ''
    }
  }

  // no onOutput override; keep internal handler intact

  const model = new TranscriptionWhispercpp(constructorArgs, config)

  // We'll attach streaming via response.onUpdate(), not model.onOutputReceived
  const streamingChunks = []

  // Don't override _outputCallback - let our override handle it
  // model._outputCallback = onOutput
  await model._load()

  const bitRate = 128000
  const bytesPerSecond = bitRate / 8
  const audioStream = fs.createReadStream(audioFilePath, { highWaterMark: bytesPerSecond })

  // High-level run(): capture the response and attach onUpdate for streaming
  const response = await model.run(audioStream)
  response.onUpdate((outputArr) => {
    const items = Array.isArray(outputArr) ? outputArr : [outputArr]
    streamingChunks.push(...items)
    const last = items[items.length - 1]
    if (last && last.text) console.log('[JS] onUpdate:', last.start, '→', last.end, last.text)
  })
  const full = []
  for await (const output of response.iterate()) {
    const items = Array.isArray(output) ? output : [output]
    full.push(...items)
  }

  await model.destroy()

  console.log('\n[JS] streaming chunks received:', streamingChunks.length)
  console.log('[JS] iterate() chunks received:', full.length)

  if (full.length) {
    const text = full.map(s => s.text).join(' ').trim()
    console.log('\n=== TRANSCRIPTION (from run/iterate) ===')
    console.log(text)
    console.log('=======================================\n')
  } else {
    console.log('No transcription output received.')
  }

  // Release logger to allow clean exit
  binding.releaseLogger()
}

main().catch(err => {
  console.error(err)
  binding.releaseLogger()
  process.exit(1)
})
