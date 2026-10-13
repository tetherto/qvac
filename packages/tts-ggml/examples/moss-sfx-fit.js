'use strict'

const process = require('bare-process')
const TTSGgml = require('@qvac/tts-ggml')

const [, , model, prompt, seconds] = process.argv
if (!model || !prompt || seconds === undefined) {
  throw new Error('Usage: bare examples/moss-sfx-fit.js <model.gguf> <prompt> <seconds>')
}

const fit = TTSGgml.assessFit({
  engineType: 'moss-sfx',
  mossSoundEffectPath: model,
  prompt,
  seconds: Number(seconds),
  useGPU: false
})
console.log(fit.report || `${fit.status}: ${fit.reason}`)
