const LlmLlamacpp = require('@qvac/llm-llamacpp')
const fabric = require('@qvac/fabric')
const { setLogger, releaseLogger } = require('@qvac/llm-llamacpp/addonLogging')
const fs = require('bare-fs')
const process = require('bare-process')

async function main() {
  const modelPath = process.argv[2]
  const backend = process.argv[3] || 'cpu'
  if (!modelPath) throw new Error('Usage: bare inference.js <model.gguf> [cpu|cuda]')
  if (!['cpu', 'cuda'].includes(backend)) throw new Error('Unknown backend ' + backend)
  if (process.env.QVAC_FABRIC_BACKENDS_DIR) {
    throw new Error('Validation must use automatic package discovery')
  }
  const logs = []
  setLogger((priority, message) => {
    logs.push(message)
    console.log(message)
  })
  const registrations = fabric.loadBackends()
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device: backend === 'cpu' ? 'cpu' : 'gpu',
      ...(backend === 'cpu' ? {} : { backend }),
      gpu_layers: backend === 'cpu' ? '0' : '999',
      ctx_size: '1024',
      n_predict: '32',
      temp: '0',
      seed: '42',
      verbosity: '2'
    },
    logger: console,
    opts: { stats: true }
  })
  await model.load()
  try {
    const completions = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await model.run([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Say hello in one short sentence.' }
      ])
      let text = ''
      await response
        .onUpdate((chunk) => {
          text += chunk
        })
        .await()
      if (!text.trim()) throw new Error('Inference produced no output')
      const stats = response.stats
      if (stats?.backendDevice !== (backend === 'cpu' ? 'cpu' : 'gpu')) {
        throw new Error('Unexpected inference device: ' + JSON.stringify(stats))
      }
      completions.push({ text: text.trim(), stats })
    }
    const mappings = [
      ...new Set(
        fs
          .readFileSync('/proc/self/maps', 'utf8')
          .split('\n')
          .map((line) => {
            const index = line.indexOf('/')
            return index < 0 ? '' : line.slice(index).trim()
          })
          .filter(
            (file) => file.includes('qvac__fabric-linux-x64') || file.includes('libqvac-ggml-')
          )
      )
    ]
    const runtimes = mappings.filter((file) => /qvac__fabric-linux-x64(@\d+)?\.bare$/.test(file))
    if (runtimes.length !== 1) {
      throw new Error('Expected one shared runtime: ' + JSON.stringify(runtimes))
    }
    if (!runtimes[0].startsWith(__dirname + '/node_modules/')) {
      throw new Error('Runtime came from outside the installed application')
    }
    if (
      backend === 'cuda' &&
      !mappings.some((file) =>
        file.includes(
          'fabric-linux-x64-cuda/prebuilds/linux-x64/qvac__fabric-linux-x64-cuda/libqvac-ggml-cuda.so'
        )
      )
    ) {
      throw new Error('CUDA was not loaded from the separate installed backend package')
    }
    const chosenGpu = logs.find((message) =>
      /Chosen (?:GPU CUDA|cuda Backend \(backend override\))/.test(message)
    )
    if (backend === 'cuda' && !chosenGpu) throw new Error('Inference did not select CUDA')
    const hipMappings = mappings.filter((file) => file.includes('libqvac-ggml-hip.so'))
    if (
      hipMappings.some(
        (file) => !file.startsWith(__dirname + '/node_modules/@qvac/fabric-linux-x64/prebuilds/')
      )
    ) {
      throw new Error('HIP loaded outside the base package')
    }
    if (fs.existsSync(__dirname + '/node_modules/@qvac/fabric-linux-x64-hip')) {
      throw new Error('Unexpected HIP package')
    }
    const evidence = {
      backend,
      registrations,
      chosenGpu,
      primaryBackendsDir: fabric.backendsDir(),
      completions,
      runtimeMappings: runtimes,
      backendMappings: mappings.filter((file) => file.includes('libqvac-ggml-'))
    }
    fs.writeFileSync('result.json', JSON.stringify(evidence, null, 2) + '\n')
    console.log('VALIDATION PASSED: ' + backend)
    console.log(JSON.stringify(evidence, null, 2))
  } finally {
    await model.unload()
    releaseLogger()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
