'use strict'

const TTSGgml = require('..')
const process = require('bare-process')

const DEFAULT_TEXT = 'The first audio should arrive while the rest of this response is generated.'
const MODES = ['batch', 'stream', 'duplex']

async function* textSource(text) {
  yield text
}

function start(model, mode, text) {
  if (mode === 'batch') return model.run({ input: text })
  if (mode === 'stream') return model.runStream(text, { maxChunkScalars: Array.from(text).length })
  return model.runStreaming(textSource(text), { accumulateSentences: false })
}

async function measure(model, mode, text) {
  const started = Date.now()
  let firstAudioMs = null
  let samples = 0
  let sampleRate = 0
  let chunks = 0
  const response = await start(model, mode, text)
  response.onUpdate((data) => {
    if (!data.outputArray?.length) return
    firstAudioMs ??= Date.now() - started
    samples += data.outputArray.length
    sampleRate = data.sampleRate
    chunks++
  })
  await response.await()
  if (firstAudioMs === null || sampleRate <= 0) throw new Error('Synthesis returned no audio')
  console.log(
    JSON.stringify({
      mode,
      firstAudioMs,
      totalMs: Date.now() - started,
      audioSeconds: samples / sampleRate,
      chunks,
      stats: response.stats
    })
  )
}

async function main() {
  const [, , modelDir, mode = 'stream', text = DEFAULT_TEXT] = process.argv
  if (!modelDir || !MODES.includes(mode)) {
    throw new Error(
      'Usage: bare examples/audio8-streaming.js MODEL_DIR [batch|stream|duplex] [TEXT]'
    )
  }
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_AUDIO8,
    files: { modelDir },
    greedy: true,
    seed: 42,
    threads: 4,
    config: { useGPU: process.env.QVAC_TTS_AUDIO8_GPU === '1' },
    opts: { stats: true }
  })
  try {
    await model.load()
    await measure(model, mode, text)
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
