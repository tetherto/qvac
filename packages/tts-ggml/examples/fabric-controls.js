'use strict'

const fs = require('bare-fs')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')

const DEFAULT_TEXT = 'Speech controls are available directly from the addon.'
const DEFAULT_OUTPUT = 'tts-controls.wav'

function readOptions() {
  const value = proc.env.QVAC_TTS_OPTIONS
  if (!value) throw new Error('Set QVAC_TTS_OPTIONS to a JSON constructor configuration')
  return JSON.parse(value)
}

function concatenatePcm(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Int16Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

async function collectAudio(response) {
  const chunks = []
  let sampleRate
  let speechTokenIds
  for await (const chunk of response.iterate()) {
    chunks.push(chunk.outputArray)
    sampleRate = chunk.sampleRate
    if (chunk.speechTokenIds) speechTokenIds = chunk.speechTokenIds
  }
  return { pcm: concatenatePcm(chunks), sampleRate, speechTokenIds }
}

async function main() {
  const argv = global.Bare ? global.Bare.argv : proc.argv
  const text = argv[2] || DEFAULT_TEXT
  const output = argv[3] || DEFAULT_OUTPUT
  const options = readOptions()
  if (proc.env.QVAC_TTS_FIT) {
    console.log('Memory preflight:', await TTSGgml.assessFit(JSON.parse(proc.env.QVAC_TTS_FIT)))
  }
  const model = new TTSGgml({ ...options, opts: { ...options.opts, stats: true } })
  try {
    await model.load()
    if (proc.env.QVAC_TTS_WARM_UP === '1') await model.warmUp(text)
    const response = await model.run({ input: text })
    const result = await collectAudio(response)
    if (!result.pcm.length) throw new Error('No audio was returned')
    createWav(result.pcm, result.sampleRate, output)
    console.log('Saved:', output)
    console.log('Stats:', response.stats)
    if (result.speechTokenIds) {
      fs.writeFileSync(output + '.tokens.json', JSON.stringify(result.speechTokenIds))
      console.log('Speech token IDs:', result.speechTokenIds.length)
    }
  } finally {
    await model.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  if (global.Bare) global.Bare.exit(1)
  else proc.exitCode = 1
})
