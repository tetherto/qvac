'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

function loadFit() {
  const filename = path.resolve(__dirname, '../../lib/fit.js')
  const calls = []
  const result = { status: 'error', reason: 'no-backend-device' }
  const binding = {
    assessFit(request) {
      calls.push(request)
      return result
    }
  }
  const exports = {}
  new Function('exports', 'require', fs.readFileSync(filename, 'utf8'))(exports, (name) =>
    name === '../binding.js' ? binding : require(`../../lib/${name}`)
  )
  return { assessFit: exports.assessFit, calls, result }
}

const workload = { engine: 'moss-transcribe', modelPath: '/models/moss.gguf', audioSeconds: 30 }

test('MOSS fit preserves explicit selectors and gpuLayers at the native boundary', async (t) => {
  const { assessFit, calls, result } = loadFit()
  for (const backend of ['auto', 'cpu', 'cuda', 'vulkan', 'CUDA1', 'Vulkan0']) {
    for (const gpuLayers of [0, 1]) {
      t.is(await assessFit({ ...workload, backend, gpuLayers }), result)
      t.is(calls.at(-1).backend, backend)
      t.is(calls.at(-1).gpuLayers, gpuLayers)
    }
  }
  // An unavailable device must remain a native error, not trigger a CPU retry.
  t.is(calls.length, 12)
})

test('MOSS fit retains the default selector and rejects invalid selector types', async (t) => {
  const { assessFit, calls } = loadFit()
  await assessFit(workload)
  t.is(calls[0].backend, undefined)
  for (const backend of [null, true, 1, {}, []]) {
    await t.exception(assessFit({ ...workload, backend }), /backend must be a string/)
  }
  t.is(calls.length, 1)
})

test('Parakeet fit forwards backend selection and preserves native device errors', async (t) => {
  const { assessFit, calls, result } = loadFit()
  for (const engine of [undefined, 'parakeet']) {
    for (const backend of [
      undefined,
      '',
      'auto',
      'cpu',
      'metal',
      'CUDA1',
      'HTP0',
      'unavailable-device'
    ]) {
      const request = { engine, backend, modelPath: '/models/asr.gguf', gpuLayers: 0 }
      t.is(await assessFit(request), result)
      t.alike(calls.at(-1), request)
    }
  }
  const callCount = calls.length
  for (const backend of [null, 1, true, {}, []]) {
    await t.exception(
      assessFit({ modelPath: '/models/asr.gguf', backend }),
      /backend must be a string/
    )
  }
  t.is(calls.length, callCount)
})
