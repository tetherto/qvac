'use strict'

const process = require('bare-process')
const ASRGgml = require('../index.js')

const [modelPath, duration] = process.argv.slice(2)
const audioSeconds = Number(duration)
if (!modelPath || !Number.isFinite(audioSeconds) || audioSeconds <= 0) {
  throw new Error('Usage: bare examples/moss-transcribe-fit.js <model.gguf> <audio-seconds>')
}

ASRGgml.assessFit({ engine: 'moss-transcribe', modelPath, audioSeconds }).then((fit) => {
  console.log(fit.report)
})
