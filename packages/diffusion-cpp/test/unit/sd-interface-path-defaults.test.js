'use strict'

const test = require('brittle')
const { SdInterface } = require('../../addon')
const { toFilePaths } = require('../../file-paths')

const KEYS = ['taesdPath', 'coremlUnetPath', 'coremlTaeDecoderPath']
const explicit = {
  taesdPath: '/models/taesd.safetensors',
  coremlUnetPath: '/models/unet.mlmodelc',
  coremlTaeDecoderPath: '/models/decoder.mlmodelc'
}

for (const [name, paths] of [
  ['omitted', {}],
  ['undefined', Object.fromEntries(KEYS.map((key) => [key, undefined]))],
  ['explicit', explicit]
]) {
  test(`SdInterface normalizes ${name} optional paths before native construction`, (t) => {
    // Model the complete pre-Core ML payload supplied by existing low-level callers.
    const configuration = toFilePaths({ model: '/models/sd.gguf' })
    for (const key of KEYS) delete configuration[key]
    Object.assign(configuration, paths)

    let captured
    let calls = 0
    const binding = {
      createInstance(_owner, params) {
        // Match the strict string reads at the native binding boundary.
        for (const key of KEYS) {
          if (typeof params[key] !== 'string') {
            throw new TypeError(`Expected property ${key} to be of type string`)
          }
        }
        captured = params
        calls++
        return {}
      }
    }

    new SdInterface(binding, configuration, () => {})
    t.is(calls, 1, 'constructs the native instance')
    for (const key of KEYS) t.is(captured[key], paths[key] ?? '')
    t.is(captured.path, '/models/sd.gguf', 'preserves the existing model path')
  })
}
