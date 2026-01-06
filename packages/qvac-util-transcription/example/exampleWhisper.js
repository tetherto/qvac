'use strict'

const fs = require('bare-fs')
const TranscriptionPipeline = require('..')
const {
  bitRate,
  setupModelStore,
  createWhisperAddonWithVad
} = require('./setupAddons')

const audioFilePath = './example/decodedSample.bin'

async function main () {
  const { hdDL } = await setupModelStore({})

  const whisper = createWhisperAddonWithVad(hdDL)

  const pipeline = new TranscriptionPipeline(
    {
      whisperAddon: whisper
    },
    {
      audioFormat: 'decoded'
    }
  )
  await pipeline.load()

  const bytesPerSecond = bitRate / 8
  const audioStream = fs.createReadStream(audioFilePath, {
    highWaterMark: bytesPerSecond
  })
  const response = await pipeline.run(audioStream)
  response.onUpdate(output => console.log('Partial transcription:', output))
  await response.await()

  await pipeline.unload()
}

main().catch(console.error)
