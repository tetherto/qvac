'use strict'

// bare examples/pocket-tts.js /absolute/bundle "Text to speak." /absolute/output.wav
// Convert the bundle with the speech repository's convert-pocket-to-gguf.py.
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const path = require('bare-path')
const process = require('bare-process')
global.process = process

async function main() {
  const [, , bundle, text = 'Hello from Pocket TTS in Fabric.', output = 'pocket-output.wav'] =
    global.Bare.argv
  if (!bundle) throw new Error('Usage: pocket-tts.js <bundle-directory> [text] [output.wav]')
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_POCKET,
    files: { modelDir: path.resolve(bundle) },
    config: { language: 'en', useGPU: false },
    threads: 1,
    seed: 1234,
    steps: 1,
    opts: { stats: true }
  })
  try {
    const start = Date.now()
    await model.load()
    console.log('Load milliseconds:', Date.now() - start)
    const response = await model.run({ input: text })
    const chunks = []
    let rate = 24000
    for await (const chunk of response.iterate()) {
      rate = chunk.sampleRate
      if (chunk.outputArray.length) chunks.push(chunk.outputArray)
    }
    const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    createWav(pcm, rate, path.resolve(output))
    console.log(JSON.stringify(response.stats, null, 2))
    console.log('Saved:', path.resolve(output))
  } finally {
    await model.destroy()
  }
}
main().catch((err) => {
  console.error(err)
  global.Bare.exit(1)
})
