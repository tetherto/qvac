'use strict'

const test = require('brittle')
const process = require('bare-process')
const TTSGgml = require('../..')

const LM = process.env.QVAC_TEST_AUDIO8_LM_GGUF
const DECODER = process.env.QVAC_TEST_AUDIO8_DECODER_GGUF
const FRAME_LIMIT = 48
const TEXT = 'The listener should hear the first words before the complete response is generated.'
const TIMEOUT_MS = 180000

async function modelFiles() {
  if (LM && DECODER) return { audio8Lm: LM, audio8CodecDecoder: DECODER }
  const { ensureAudio8Models } = require('../utils/downloadModel')
  const models = await ensureAudio8Models({ includeEncoder: false })
  if (!models.success) throw new Error('Audio8 streaming tests require LM and decoder GGUFs')
  return { audio8Lm: models.lmPath, audio8CodecDecoder: models.decoderPath }
}

async function* source() {
  yield TEXT
}

function run(model, method) {
  if (method === 'runStream') return model.runStream(TEXT)
  if (method === 'runStreaming') {
    return model.runStreaming(source(), { accumulateSentences: false })
  }
  return model.run({ input: TEXT, streamOutput: true })
}

for (const method of ['runStream', 'runStreaming', 'streamOutput']) {
  test(
    `Audio8 ${method} delivers native PCM without replay`,
    { timeout: TIMEOUT_MS },
    async (t) => {
      const model = new TTSGgml({
        engine: TTSGgml.ENGINE_AUDIO8,
        files: await modelFiles(),
        greedy: true,
        threads: 4,
        maxFrames: FRAME_LIMIT,
        opts: { stats: true }
      })
      try {
        await model.load()
        let chunks = 0
        let samples = 0
        const response = await run(model, method)
        response.onUpdate((chunk) => {
          if (!chunk.outputArray?.length) return
          t.is(chunk.sampleRate, 44100)
          chunks++
          samples += chunk.outputArray.length
        })
        await response.await()
        t.ok(chunks > 1, 'multiple codec windows reached JavaScript')
        t.is(samples, response.stats.totalSamples, 'PCM was delivered exactly once')
        t.is(response.stats.generatedFrames, FRAME_LIMIT)
      } finally {
        await model.unload()
      }
    }
  )
}
