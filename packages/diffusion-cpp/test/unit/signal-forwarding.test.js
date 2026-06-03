'use strict'

// Verifies that a per-call AbortSignal passed to the image/video/upscale run
// methods is forwarded into the returned QvacResponse, so aborting mid-job (or
// passing an already-aborted signal) settles the in-flight response with the
// abort reason. The signal must NOT be part of native runJob params.

const test = require('brittle')
const { ImgStableDiffusion, VideoStableDiffusion, EsrganUpscaler } = require('../../index.js')

function makeAbortable () {
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener (event, cb, opts) {
      if (event !== 'abort') return
      const wrapped = opts && opts.once ? () => { listeners.delete(wrapped); cb() } : cb
      wrapped._original = cb
      listeners.add(wrapped)
    },
    removeEventListener (event, cb) {
      if (event !== 'abort') return
      for (const l of listeners) if (l === cb || l._original === cb) { listeners.delete(l); return }
    }
  }
  return {
    signal,
    abort (reason) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason
      for (const l of Array.from(listeners)) l()
    }
  }
}

async function expectRejection (t, promise, re, message) {
  let err
  try { await promise } catch (e) { err = e }
  t.ok(err, `${message}: rejected`)
  t.ok(err && re.test(err.message), `${message}: reason "${err && err.message}" matches ${re}`)
}

// Records the params handed to runJob so we can assert `signal` is not present.
function fakeAddonFactory (sink) {
  return () => ({
    activate: async () => {},
    runJob: async (a) => { sink.lastJobParams = a; return true },
    cancel: async () => {},
    unload: async () => {}
  })
}

test('ImgStableDiffusion.run(): aborting rejects with reason and keeps signal out of native params', async (t) => {
  const sink = {}
  const model = new ImgStableDiffusion({ files: { model: '/tmp/fake-sd.gguf' }, config: {} })
  model._createAddon = fakeAddonFactory(sink)
  await model.load()

  const { signal, abort } = makeAbortable()
  const response = await model.run({ prompt: 'a cat' }, { signal })
  const settled = response.await()

  t.absent(sink.lastJobParams && 'signal' in sink.lastJobParams, 'signal not forwarded to runJob')

  abort(new Error('img abort'))
  await expectRejection(t, settled, /img abort/, 'await()')

  await model.unload()
})

test('ImgStableDiffusion.run(): an already-aborted signal rejects immediately', async (t) => {
  const model = new ImgStableDiffusion({ files: { model: '/tmp/fake-sd.gguf' }, config: {} })
  model._createAddon = fakeAddonFactory({})
  await model.load()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = await model.run({ prompt: 'a cat' }, { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')

  await model.unload()
})

test('VideoStableDiffusion.run(): aborting rejects with reason and keeps signal out of native params', async (t) => {
  const sink = {}
  const model = new VideoStableDiffusion({ files: { model: '/tmp/fake-wan.gguf' }, config: {} })
  model._createAddon = fakeAddonFactory(sink)
  await model.load()

  const { signal, abort } = makeAbortable()
  const response = await model.run({ mode: 'txt2vid', prompt: 'a wave' }, { signal })
  const settled = response.await()

  t.absent(sink.lastJobParams && 'signal' in sink.lastJobParams, 'signal not forwarded to runJob')

  abort(new Error('video abort'))
  await expectRejection(t, settled, /video abort/, 'await()')

  await model.unload()
})

test('EsrganUpscaler.upscale(): aborting rejects with the abort reason', async (t) => {
  const model = new EsrganUpscaler({ files: { esrgan: '/tmp/fake-esrgan.gguf' }, config: {} })
  model._createAddon = () => ({
    activate: async () => {},
    runJob: async () => true,
    cancel: async () => {},
    unload: async () => {}
  })
  await model.load()

  const { signal, abort } = makeAbortable()
  const response = await model.upscale(new Uint8Array([1, 2, 3]), { signal })
  const settled = response.await()

  abort(new Error('upscale abort'))
  await expectRejection(t, settled, /upscale abort/, 'await()')

  await model.unload()
})
