'use strict'

// Copy into a consumer app installed from local npm tarballs.
const LlmLlamacpp = require('@qvac/llm-llamacpp')
const nativeLogging = require('@qvac/llm-llamacpp/addonLogging')
const { model: modelPath, device = 'cpu', backend } = require('./config.json')

nativeLogging.setLogger((priority, message) => console.log('NATIVE', priority, message))

async function main () {
  console.log('PACKAGES', require.resolve('@qvac/llm-llamacpp'), require.resolve('@qvac/fabric'))
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device,
      ...(backend ? { backend } : {}),
      gpu_layers: device === 'gpu' ? '999' : '0',
      ctx_size: '1024',
      n_predict: '128',
      threads: '4',
      verbosity: '3'
    },
    logger: console,
    opts: { stats: true }
  })
  await model.load()
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await model.run([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Explain in a short paragraph how a rainbow forms.' }
      ])
      let output = ''
      await response.onUpdate(chunk => { output += chunk }).await()
      if (!output.trim()) throw new Error('Empty inference output')
      if (response.stats.backendDevice !== device) {
        throw new Error(`Expected ${device}; got ${response.stats.backendDevice}`)
      }
      console.log('INFERENCE', JSON.stringify({ attempt, output: output.trim(), stats: response.stats }))
    }
  } finally {
    await model.unload()
  }
  console.log('PACKAGED INFERENCE PASS')
}

main().catch(error => {
  console.error(error)
  Bare.exitCode = 1
}).finally(() => nativeLogging.releaseLogger())
