'use strict'

const fs = require('bare-fs')
const TranscriptionPipeline = require('..')
const {
  setupModelStore,
  createWhisperAddonWithVad
} = require('./setupAddons')

const inputOgg = './example/sample.ogg'

async function main () {
  const { hdDL } = await setupModelStore({})

  const whisper = createWhisperAddonWithVad(hdDL)

  const pipeline = new TranscriptionPipeline(
    {
      whisperAddon: whisper
    },
    {
      audioFormat: 'encoded'
    }
  )

  await pipeline.load()

  const audioStream = fs.createReadStream(inputOgg)

  const response = await pipeline.run(audioStream)
  response.onUpdate(output => console.log('Partial transcription:', output))
  await response.await()

  await pipeline.unload()
}

main().catch(console.error)
