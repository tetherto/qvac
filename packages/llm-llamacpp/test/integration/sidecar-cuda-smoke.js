'use strict'

// Run with bare-sidecar's bare binary, not through brittle:
//
//   <bare-sidecar>/prebuilds/linux-x64/bare test/integration/sidecar-cuda-smoke.js <model.gguf>
//
// Fails unless the default backend cascade chooses CUDA. The suite runs under
// `bare`, whose binary links libstdc++, so a GPU module that needs a C++
// runtime from the process loads there; bare-sidecar maps none, and such a
// module fails to dlopen and leaves inference on CPU without an error.
//
// The caller provides the model because ./utils pulls in bare-crypto and
// bare-https, whose prebuilds NEED libstdc++ and would mask the failure.

const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const { attachSpecLogger } = require('./spec-logger')

function mappedCxxRuntimes() {
  const maps = fs.readFileSync('/proc/self/maps', 'utf8')
  return [...new Set(maps.match(/[^\s/]*lib(?:stdc\+\+|c\+\+|c\+\+abi)\.so[^\s/]*$/gm) || [])]
}

async function main() {
  const modelPath = process.argv[2]
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error(`usage: sidecar-cuda-smoke.js <model.gguf> (got ${modelPath})`)
  }
  const preloaded = mappedCxxRuntimes()
  if (preloaded.length > 0) {
    throw new Error(
      `this binary already maps ${preloaded.join(', ')}; run it with bare-sidecar's bare`
    )
  }

  const specLogger = attachSpecLogger({ forwardToConsole: false })
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: { device: 'gpu', gpu_layers: '999', ctx_size: '512', n_predict: '8', verbosity: '2' },
    logger: console
  })

  let chosen
  try {
    await model.load()
    const response = await model.run([{ role: 'user', content: 'Say hello.' }])
    await response.onUpdate(() => {}).await()
    // Read after the run: backend selection is lazy.
    chosen = specLogger.logs.find((line) => /Chosen GPU/.test(line))
  } finally {
    await model.unload().catch(() => {})
    specLogger.release()
  }

  const mapped = mappedCxxRuntimes()
  console.log(`backend: ${chosen || 'no GPU chosen'}`)
  console.log(`C++ runtimes mapped after load: ${mapped.join(', ') || 'none'}`)
  if (!chosen || !/Chosen GPU CUDA/.test(chosen)) {
    for (const line of specLogger.logs.filter((l) => /ggml_backend|dlopen|cuda/i.test(l))) {
      console.log(line)
    }
    throw new Error(
      'CUDA was not chosen under bare-sidecar; check the fabric prebuilds with ' +
        '.github/scripts/check-linux-module-cxx-runtime.mjs'
    )
  }
  if (mapped.length > 0) {
    // Something in the load pulled one in (CUDA 13.4's libcudart and Mesa's
    // Vulkan ICDs NEED libstdc++; CUDA 13.0's libcudart does not), so this host
    // cannot tell a self-contained module from one that is not. The prebuild
    // symbol check still covers that.
    console.log(
      `::warning::${mapped.join(', ')} mapped during load; this run cannot catch a module that needs it`
    )
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
