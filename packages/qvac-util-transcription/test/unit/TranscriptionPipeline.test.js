'use strict'

const test = require('brittle')
const { Readable } = require('bare-stream')
const TranscriptionPipeline = require('../../index.js')
const { QvacErrorTranscriptionUtils } = require('../../src/utils/errors.js')

const decoderAddon = require('@qvac/decoder-audio')

// Mock whisper addon for unit testing (avoids dependency on model files)
const whisperAddon = {
  load: () => Promise.resolve(),
  unload: () => Promise.resolve(),
  run: () => Promise.resolve({ onUpdate: () => ({ onFinish: () => {} }), onFinish: () => {} }),
  pause: () => Promise.resolve(),
  unpause: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  download: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  status: () => 'ready',
  getApiDefinition: () => 'mock-api'
}

function setupMocks () {
  const calls = []

  function track (obj, method, returnValue) {
    const original = obj[method]
    obj[method] = function (...args) {
      calls.push({ obj, method, args })
      return returnValue
    }
    obj[method].original = original
  }

  function restore () {
    calls.forEach(({ obj, method }) => {
      if (obj[method].original) {
        obj[method] = obj[method].original
      }
    })
    calls.length = 0
  }

  function wasCalled (obj, method) {
    return calls.some(call => call.obj === obj && call.method === method)
  }

  function wasCalledWith (obj, method, expectedArgs) {
    return calls.some(call =>
      call.obj === obj &&
      call.method === method &&
      call.args.length === expectedArgs.length &&
      call.args.every((arg, i) => arg === expectedArgs[i])
    )
  }

  return { track, restore, wasCalled, wasCalledWith, calls }
}

test('constructor requires whisperAddon', (t) => {
  const addons = {}

  t.exception(() => {
    const pipeline = new TranscriptionPipeline(addons)
    return pipeline
  }, QvacErrorTranscriptionUtils)

  t.end()
})

test('constructor validates supported addons', (t) => {
  const addons = {
    whisperAddon,
    invalidAddon: {}
  }

  t.exception(() => {
    const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'decoded' })
    return pipeline
  }, QvacErrorTranscriptionUtils)

  t.end()
})

test('constructor validates audioFormat options', (t) => {
  const addons = { whisperAddon }

  t.exception(() => {
    const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'invalid' })
    return pipeline
  }, QvacErrorTranscriptionUtils)

  t.end()
})

test('constructor sets default audioFormat to encoded', (t) => {
  const addons = { whisperAddon }
  const pipeline = new TranscriptionPipeline(addons)

  t.is(pipeline.config.audioFormat, 'encoded')
  t.end()
})

test('constructor initializes addons correctly', (t) => {
  const addons = { whisperAddon, decoder: decoderAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'encoded' })

  t.ok(pipeline.whisperAddon)
  t.ok(pipeline.decoder)
  t.end()
})

test('run method orchestrates whisper-only pipeline', async (t) => {
  const mocks = setupMocks()
  const defaultReturn = Promise.resolve({ onUpdate: () => ({ onFinish: () => {} }), onFinish: () => {} })

  mocks.track(whisperAddon, 'run', defaultReturn)

  const addons = { whisperAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'decoded' })
  const mockStream = new Readable({ read () {} })

  await pipeline.run(mockStream)

  t.ok(mocks.wasCalled(whisperAddon, 'run'))
  t.ok(mocks.wasCalledWith(whisperAddon, 'run', [mockStream]))

  mocks.restore()
  t.end()
})

test('run method orchestrates decoder+whisper pipeline', async (t) => {
  const mocks = setupMocks()

  const decoderResult = {
    onUpdate: (callback) => {
      const data = { outputArray: new Float32Array([1, 2, 3]) }
      setTimeout(() => callback(data), 10)
      return { onFinish: (finishCallback) => setTimeout(() => finishCallback(), 20) }
    },
    onFinish: () => {}
  }

  const whisperResult = { onUpdate: () => ({ onFinish: () => {} }), onFinish: () => {} }

  mocks.track(decoderAddon, 'run', Promise.resolve(decoderResult))
  mocks.track(whisperAddon, 'run', Promise.resolve(whisperResult))

  const addons = { whisperAddon, decoder: decoderAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'encoded' })
  const mockStream = new Readable({ read () {} })

  await pipeline.run(mockStream)

  t.ok(mocks.wasCalled(decoderAddon, 'run'))
  t.ok(mocks.wasCalledWith(decoderAddon, 'run', [mockStream]))

  await new Promise(resolve => setTimeout(resolve, 30))

  t.ok(mocks.wasCalled(whisperAddon, 'run'))

  const whisperCallArgs = mocks.calls.find(call => call.obj === whisperAddon && call.method === 'run')?.args

  t.ok(whisperCallArgs && whisperCallArgs[0] !== mockStream, 'whisper receives processed stream, not original')

  mocks.restore()
  t.end()
})

test('run method data flow - whisper receives decoder output', async (t) => {
  const mocks = setupMocks()
  let capturedWhisperInput = null

  const decoderResult = {
    onUpdate: (callback) => {
      const data = { outputArray: new Float32Array([1, 2, 3]) }
      setTimeout(() => callback(data), 5)
      return { onFinish: (finishCallback) => setTimeout(() => finishCallback(), 10) }
    },
    onFinish: () => {}
  }

  const whisperResult = {
    onUpdate: () => ({ onFinish: () => {} }),
    onFinish: () => {}
  }

  mocks.track(decoderAddon, 'run', Promise.resolve(decoderResult))
  mocks.track(whisperAddon, 'run', (inputStream) => {
    capturedWhisperInput = inputStream
    return Promise.resolve(whisperResult)
  })

  const addons = { decoder: decoderAddon, whisperAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'encoded' })
  const originalStream = new Readable({ read () {} })

  const runPromise = pipeline.run(originalStream).catch(err => new Error(err))

  await new Promise(resolve => setTimeout(resolve, 20))

  t.ok(capturedWhisperInput !== originalStream, 'whisper receives transformed stream from decoder')
  t.ok(typeof capturedWhisperInput === 'object', 'whisper input is a stream-like object')

  mocks.restore()
  await runPromise
  t.end()
})

test('load method calls all addon load methods', async (t) => {
  const mocks = setupMocks()
  const defaultReturn = Promise.resolve()

  mocks.track(decoderAddon, 'load', defaultReturn)
  mocks.track(whisperAddon, 'load', defaultReturn)

  const addons = { whisperAddon, decoder: decoderAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'encoded' })

  await pipeline.load()

  t.ok(mocks.wasCalled(decoderAddon, 'load'))
  t.ok(mocks.wasCalled(whisperAddon, 'load'))

  mocks.restore()
  t.end()
})

test('unload method calls all addon unload methods', async (t) => {
  const mocks = setupMocks()
  const defaultReturn = Promise.resolve()

  mocks.track(decoderAddon, 'unload', defaultReturn)
  mocks.track(whisperAddon, 'unload', defaultReturn)

  const addons = { whisperAddon, decoder: decoderAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'encoded' })

  await pipeline.unload()

  t.ok(mocks.wasCalled(decoderAddon, 'unload'))
  t.ok(mocks.wasCalled(whisperAddon, 'unload'))

  mocks.restore()
  t.end()
})

test('pause method calls all addon pause methods', async (t) => {
  const mocks = setupMocks()
  const defaultReturn = Promise.resolve()

  mocks.track(decoderAddon, 'pause', defaultReturn)
  mocks.track(whisperAddon, 'pause', defaultReturn)

  const addons = { whisperAddon, decoder: decoderAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'encoded' })

  await pipeline.pause()

  t.ok(mocks.wasCalled(decoderAddon, 'pause'))
  t.ok(mocks.wasCalled(whisperAddon, 'pause'))

  mocks.restore()
  t.end()
})

test('stop method calls all addon stop methods', async (t) => {
  const mocks = setupMocks()
  const defaultReturn = Promise.resolve()

  mocks.track(decoderAddon, 'stop', defaultReturn)
  mocks.track(whisperAddon, 'stop', defaultReturn)

  const addons = { whisperAddon, decoder: decoderAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'encoded' })

  await pipeline.stop()

  t.ok(mocks.wasCalled(decoderAddon, 'stop'))
  t.ok(mocks.wasCalled(whisperAddon, 'stop'))

  mocks.restore()
  t.end()
})

test('status method delegates to whisper addon', (t) => {
  const mocks = setupMocks()

  mocks.track(whisperAddon, 'status', 'ready')

  const addons = { whisperAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'decoded' })

  const status = pipeline.status()

  t.is(status, 'ready')
  t.ok(mocks.wasCalled(whisperAddon, 'status'))

  mocks.restore()
  t.end()
})

test('getApiDefinition method delegates to whisper addon', (t) => {
  const mocks = setupMocks()

  mocks.track(whisperAddon, 'getApiDefinition', 'test-api')

  const addons = { whisperAddon }
  const pipeline = new TranscriptionPipeline(addons, { audioFormat: 'decoded' })

  const apiDef = pipeline.getApiDefinition()

  t.is(apiDef, 'test-api')
  t.ok(mocks.wasCalled(whisperAddon, 'getApiDefinition'))

  mocks.restore()
  t.end()
})
