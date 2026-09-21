'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ASRGgml = require('../index.js')
const binding = require('../binding.js')
const { parseQuickstartArguments } = require('./quickstart-arguments.js')

const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
binding.setLogger((priority, message) => {
  const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
  console.log(`[C++ ${priorityName}] ${message}`)
})

async function main() {
  const { audioPath, modelPath, vadModelPath } = parseQuickstartArguments(Bare.argv.slice(2))

  const modelsDir = path.join(__dirname, '..', 'models')
  const audioFilePath = audioPath || path.join(__dirname, 'samples', 'sample.raw')
  const modelFilePath = modelPath || path.join(modelsDir, 'ggml-tiny.bin')
  const vadModelFilePath = vadModelPath || path.join(modelsDir, 'ggml-silero-v5.1.2.bin')

  if (!fs.existsSync(audioFilePath)) {
    console.error(`Audio file not found at ${audioFilePath}. Provide it as the first argument.`)
    Bare.exit(1)
    return
  }
  if (!fs.existsSync(modelFilePath)) {
    console.error(`Model file not found at ${modelFilePath}. Provide it as the second argument.`)
    Bare.exit(1)
    return
  }
  if (!fs.existsSync(vadModelFilePath)) {
    console.error(
      `VAD model file not found at ${vadModelFilePath}. Provide it as the third argument.`
    )
    Bare.exit(1)
    return
  }

  const constructorArgs = {
    files: {
      model: modelFilePath,
      vadModel: vadModelFilePath
    },
    enableStats: true
  }

  const config = {
    engine: 'whisper',
    whisperConfig: {
      audio_format: 's16le',
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

  const model = new ASRGgml({ ...constructorArgs, config })

  const streamingChunks = []

  await model.load()

  const bitRate = 128000
  const bytesPerSecond = bitRate / 8
  const audioStream = fs.createReadStream(audioFilePath, { highWaterMark: bytesPerSecond })

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
    const text = full
      .map((s) => s.text)
      .join(' ')
      .trim()
    console.log('\n=== TRANSCRIPTION (from run/iterate) ===')
    console.log(text)
    console.log('=======================================\n')
  } else {
    console.log('No transcription output received.')
  }

  binding.releaseLogger()
}

main().catch((err) => {
  console.error(err)
  binding.releaseLogger()
  Bare.exit(1)
})
