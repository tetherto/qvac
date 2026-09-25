'use strict'
const test = require('brittle')
const TTSGgml = require('../../index')
const { TTSInterface } = require('../../tts')
const MockedBinding = require('../mock/MockedBinding')
const process = require('bare-process')
const path = require('bare-path')
global.process = process
const files = { modelDir: '/models/pocket' }
const make = (options = {}) => new TTSGgml({ engine: 'pocket', files, ...options })

test('Pocket defaults to one step and preserves explicit sampling controls', (t) => {
  t.is(make()._buildTtsParams().steps, 1)
  t.is(make({ steps: 1 })._buildTtsParams().steps, 1)
  t.is(make({ steps: 4 })._buildTtsParams().steps, 4)
  t.is(make({ numInferenceSteps: 2 })._buildTtsParams().steps, 2)
  t.is(make({ steps: 8, numInferenceSteps: 8 })._buildTtsParams().steps, 8)
})

test('Pocket bundle resolution and unsigned seed are preserved', (t) => {
  const m = make({ seed: 4294967295, temperature: 0, steps: 1 })
  t.is(m.getEngineType(), TTSGgml.ENGINE_POCKET)
  t.alike(m._buildTtsParams(), {
    engineType: 'pocket',
    pocketFlowModelPath: path.join(files.modelDir, 'flow-lm.gguf'),
    pocketMimiModelPath: path.join(files.modelDir, 'mimi.gguf'),
    pocketFrontendPath: path.join(files.modelDir, 'frontend.json'),
    pocketVoicePath: path.join(files.modelDir, 'voice.gguf'),
    referenceAudio: '',
    language: 'en',
    useGPU: false,
    seed: 4294967295,
    temperature: 0,
    steps: 1
  })
  t.is(
    new TTSGgml({ files: { ...files, pocketFlowModel: '/custom/flow.gguf' } }).getEngineType(),
    'pocket'
  )
  const ref = make({ referenceAudio: '/voice.wav' })._buildTtsParams()
  t.is(ref.referenceAudio, '/voice.wav')
  t.is(ref.pocketVoicePath, '')
  t.exception(() =>
    make({ files: { ...files, pocketVoice: '/voice.gguf' }, referenceAudio: '/voice.wav' })
  )
})

test('Pocket rejects unsupported and malformed options before native loading', (t) => {
  for (const options of [
    { seed: -1 },
    { seed: 4294967296 },
    { seed: 1.5 },
    { seed: '123' },
    { steps: 0 },
    { steps: 65 },
    { steps: 1, numInferenceSteps: 2 },
    { temperature: NaN },
    { temperature: Infinity },
    { temperature: -1 },
    { threads: 0 },
    { nCtx: 8193 },
    { maxTokens: 0 },
    { noiseClamp: -1 },
    { framesAfterEos: 101 },
    { eosThreshold: Infinity },
    { speed: 1 },
    { streamChunkTokens: 1 },
    { voice: 'alba' },
    { nGpuLayers: 99 },
    { config: { useGPU: true } },
    { config: { language: 'fr' } },
    { config: { outputSampleRate: NaN } },
    { config: { outputSampleRate: 24000.5 } }
  ]) {
    t.exception(() => make(options), String(Object.keys(options)))
  }
})

test('Pocket invalid reload preserves configuration; valid reload forwards sample rate', async (t) => {
  const model = make()
  let params
  model._createAddon = (p, cb) => {
    params = p
    return new TTSInterface(new MockedBinding(), p, cb)
  }
  await model.load()
  t.is(params.steps, 1)
  const original = model.addon
  await t.exception(model.reload({ useGPU: true }))
  t.is(model.addon, original, 'invalid options retain the loaded engine')
  t.is(model.getState().weightsLoaded, true)
  t.is(model._buildTtsParams().useGPU, false)
  await model.reload({ outputSampleRate: 44100 })
  t.is(params.outputSampleRate, 44100)
  t.is(params.steps, 1)
  await model.destroy()
})

test('Pocket terminal marker is the only last event in sentence streaming', (t) => {
  const m = make()
  const events = []
  m._job.output = (data) => events.push(data)
  m._sentenceStreamCtx = { chunkIdx: 0, chunks: ['Hello.'] }
  m._addonOutputCallback(null, null, { outputArray: new Int16Array([1]), isLast: false })
  m._addonOutputCallback(null, null, { outputArray: new Int16Array(), isLast: true })
  t.is(events[0].isLast, false)
  t.is(events[1].isLast, true)
})

test('Pocket reload releases the old model before allocating its replacement', async (t) => {
  const model = make()
  let live = 0
  let peak = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let entered
  const teardownStarted = new Promise((resolve) => {
    entered = resolve
  })
  const events = []
  let created = 0
  model._createAddon = () => {
    const id = ++created
    events.push(`create ${id}`)
    peak = Math.max(peak, ++live)
    return {
      activate: async () => {
        events.push(`activate ${id}`)
      },
      cancel: async () => {
        events.push(`cancel ${id}`)
      },
      destroyInstance: async () => {
        events.push(`destroy ${id}`)
        if (id === 1) {
          entered()
          await gate
        }
        live--
        events.push(`released ${id}`)
      }
    }
  }
  await model.load()
  const reloading = model.reload({ outputSampleRate: 44100 })
  await teardownStarted
  t.is(created, 1, 'replacement waits for asynchronous teardown')
  await t.exception(model.run({ input: 'Wait.' }), /already in progress/)
  await t.exception(model.reload(), /already in progress/)
  await t.exception(model.destroy(), /already in progress/)
  release()
  await reloading
  t.is(peak, 1, 'at most one native model instance exists')
  t.alike(events, [
    'create 1',
    'activate 1',
    'cancel 1',
    'destroy 1',
    'released 1',
    'create 2',
    'activate 2'
  ])
  t.is(model._outputSampleRate, 44100)
  t.is(model.state.weightsLoaded, true)
  await model.destroy()
  t.is(live, 0)
})

test('Pocket failed replacement leaves an unloaded instance recoverable with the last good config', async (t) => {
  for (const failure of ['construction', 'activation']) {
    const model = make({ steps: 4, config: { outputSampleRate: 32000 } })
    let attempts = 0
    let disposed = 0
    let params
    model._createAddon = (p) => {
      params = p
      const id = ++attempts
      if (id === 2 && failure === 'construction') throw new Error('construction failed')
      return {
        activate: async () => {
          if (id === 2) throw new Error('activation failed')
        },
        cancel: async () => {},
        destroyInstance: async () => {
          disposed++
        }
      }
    }
    await model.load()
    await t.exception(model.reload({ outputSampleRate: 44100, steps: 8 }), /failed/)
    t.is(model.addon, null)
    t.is(model._outputSampleRate, 32000)
    t.is(model._buildTtsParams().steps, 4)
    t.is(model._buildTtsParams().outputSampleRate, 32000)
    t.is(
      disposed,
      failure === 'construction' ? 1 : 2,
      'old model and any failed replacement are disposed'
    )
    t.is(model.getState().configLoaded, false)
    t.is(model.getState().weightsLoaded, false)
    await t.exception(model.run({ input: 'Not loaded.' }), /not loaded/)
    await model.load()
    t.is(params.steps, 4)
    t.is(params.outputSampleRate, 32000)
    t.is(model.getState().weightsLoaded, true)
    await model.destroy()
  }
})

test('Pocket does not allocate a replacement if old teardown fails', async (t) => {
  const model = make()
  let created = 0
  model._createAddon = () => {
    const id = ++created
    return {
      activate: async () => {},
      cancel: async () => {},
      destroyInstance: async () => {
        if (id === 1) throw new Error('old teardown failed')
      }
    }
  }
  await model.load()
  await t.exception(model.reload({ outputSampleRate: 44100 }), /old teardown failed/)
  t.is(created, 1)
  t.is(model.addon, null)
  t.is(model._outputSampleRate, null)
  t.is(model.state.configLoaded, false)
  t.is(model.state.weightsLoaded, false)
  await model.destroy()
})

test('Pocket invalidates delayed streaming text across reload and cancellation', async (t) => {
  for (const action of ['reload', 'cancel']) {
    const model = make()
    const dispatched = []
    model._createAddon = () => ({
      activate: async () => {},
      cancel: async () => {},
      destroyInstance: async () => {},
      runJob: async (data) => {
        dispatched.push(data.input)
      }
    })
    await model.load()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    async function* input() {
      await gate
      yield 'Old text must not run.'
    }
    const response = await model.runStreaming(input(), { accumulateSentences: false })
    const settled = response.await().catch(() => {})
    await model[action]()
    release()
    await settled
    await new Promise((resolve) => setTimeout(resolve, 1))
    t.alike(dispatched, [], action)
    t.is(model._sentenceStreamCtx, null)
    await model.destroy()
  }
})

test('Pocket rejected native dispatch clears its completion barrier', async (t) => {
  const model = make()
  model._createAddon = (params, cb) => {
    const binding = new MockedBinding()
    binding.runJob = () => false
    return new TTSInterface(binding, params, cb)
  }
  await model.load()
  await t.exception(model.run({ input: 'Native queue is busy.' }))
  t.is(model._pocketJobPending, null)
  await model.cancel()
  await model.reload({ outputSampleRate: 44100 })
  t.is(model.state.weightsLoaded, true)
  await model.destroy()
})

test('Pocket waits for the old terminal event before accepting a post-cancel request', async (t) => {
  const model = make()
  const dispatched = []
  let callback
  model._createAddon = (params, cb) => {
    callback = cb
    return {
      activate: async () => {},
      destroyInstance: async () => {},
      cancel: async () => {},
      runJob: async (data) => {
        dispatched.push(data.input)
      }
    }
  }
  await model.load()
  const first = await model.run({ input: 'First.' })
  const firstDone = first.await().catch(() => {})
  const cancelled = model.cancel()
  const next = model.run({ input: 'Second.' })
  await firstDone
  await new Promise((resolve) => setTimeout(resolve, 1))
  t.alike(dispatched, ['First.'])
  callback(model.addon, null, null, 'Old request cancelled')
  await cancelled
  const second = await next
  callback(model.addon, null, { outputArray: new Int16Array([123]), sampleRate: 24000 })
  callback(model.addon, null, { totalTime: 0.1, totalSamples: 1 })
  const output = await second.await()
  t.alike(dispatched, ['First.', 'Second.'])
  t.is(output[0].outputArray[0], 123)
  await model.destroy()
})

test('Pocket rejects every request entry point before load and after disposal', async (t) => {
  const model = make()
  model._createAddon = (p, cb) => new TTSInterface(new MockedBinding(), p, cb)
  async function* empty() {}
  const check = async (pattern) => {
    await t.exception(model.run({ input: 'Hello.' }), pattern)
    await t.exception(model.runStream('Hello.'), pattern)
    await t.exception(model.runStreaming(empty(), { accumulateSentences: false }), pattern)
    t.is(model._job.active, null)
  }
  await check(/not loaded/)
  await model.load()
  await model.unload()
  t.is(model.addon, null)
  await check(/not loaded/)
  await model.destroy()
  await check(/destroyed/)
})

test('Pocket reload and destroy after unload never use a disposed handle', async (t) => {
  const model = make()
  let disposed = 0
  model._createAddon = (p, cb) => {
    const binding = new MockedBinding()
    const cancel = binding.cancel.bind(binding)
    const destroy = binding.destroyInstance.bind(binding)
    binding.cancel = (handle) => {
      if (!handle) throw new Error('Disposed native handle')
      return cancel(handle)
    }
    binding.destroyInstance = (handle) => {
      disposed++
      return destroy(handle)
    }
    return new TTSInterface(binding, p, cb)
  }
  await model.load()
  await model.unload()
  await model.reload()
  t.is(model.state.weightsLoaded, true)
  await model.unload()
  await model.destroy()
  await model.destroy()
  t.is(disposed, 2)
  t.is(model.addon, null)
})

test('Pocket rejects overlapping lifecycle operations while activation is pending', async (t) => {
  const model = make()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let created = 0
  let disposed = 0
  model._createAddon = () => {
    created++
    return {
      activate: () => gate,
      cancel: async () => {},
      destroyInstance: async () => {
        disposed++
      }
    }
  }
  const loading = model.load()
  await t.exception(model.load(), /already in progress/)
  await t.exception(model.unload(), /already in progress/)
  await t.exception(model.destroy(), /already in progress/)
  await t.exception(model.reload(), /already in progress/)
  t.is(created, 1)
  release()
  await loading
  await model.destroy()
  t.is(disposed, 1)
})

test('Pocket AbortSignal stops native work and drains before admitting its successor', async (t) => {
  const model = make()
  let callback
  let cancels = 0
  const dispatched = []
  model._createAddon = (p, cb) => {
    callback = cb
    return {
      activate: async () => {},
      destroyInstance: async () => {},
      cancel: async () => {
        cancels++
      },
      runJob: async (data) => {
        dispatched.push(data.input)
      }
    }
  }
  // Structural signal works on Bare versions without a global AbortController.
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: new Error('Caller aborted'),
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener)
  }
  await model.load()
  const first = await model.run({ input: 'First.', signal })
  const failed = t.exception(first.await(), /Caller aborted/)
  signal.aborted = true
  for (const listener of [...listeners]) listener()
  await failed
  t.is(cancels, 1)
  const next = model.run({ input: 'Second.' })
  await new Promise((resolve) => setTimeout(resolve, 1))
  t.alike(dispatched, ['First.'])
  callback(model.addon, null, null, 'Cancelled')
  const second = await next
  callback(model.addon, null, { outputArray: new Int16Array([1]) })
  callback(model.addon, null, { totalTime: 0.1, totalSamples: 1 })
  await second.await()
  t.alike(dispatched, ['First.', 'Second.'])
  t.is(listeners.size, 0)
  const stale = await model.run({ input: 'Never dispatched.', signal })
  await t.exception(stale.await(), /Caller aborted/)
  t.is(dispatched.length, 2)
  await model.destroy()
})

test('Pocket rejected dispatch settles both streaming APIs without unhandled rejections', async (t) => {
  for (const method of ['runStream', 'runStreaming']) {
    const model = make()
    model._createAddon = () => ({
      activate: async () => {},
      cancel: async () => {},
      destroyInstance: async () => {},
      runJob: async () => {
        throw new Error('dispatch failed')
      }
    })
    await model.load()
    const response = await model[method]('Hello.', { accumulateSentences: false })
    await t.exception(response.await(), /dispatch failed/)
    await new Promise((resolve) => setTimeout(resolve, 1))
    t.is(model._pocketJobPending, null)
    t.is(model._sentenceStreamCtx, null)
    await model.destroy()
  }
})

class FirstAudioBinding extends MockedBinding {
  constructor(firstAudioValues) {
    super()
    this.firstAudioValues = firstAudioValues
    this.jobs = 0
  }

  _callCallbacks(type, data, error) {
    if (type !== 'RuntimeStats') return super._callCallbacks(type, data, error)
    const firstAudioMs = this.firstAudioValues[this.jobs++ % this.firstAudioValues.length]
    super._callCallbacks(type, { ...data, firstAudioMs }, error)
  }
}

async function assertFirstAudioStats(t, method, values) {
  const model = make({ opts: { stats: true } })
  const binding = new FirstAudioBinding(values)
  model._createAddon = (params, cb) => new TTSInterface(binding, params, cb)
  try {
    await model.load()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response =
        method === 'runStream'
          ? await model.runStream('First sentence. Second sentence.', { maxChunkScalars: 16 })
          : await model.runStreaming(
              (async function* () {
                yield 'First sentence.'
                yield 'Second sentence.'
              })(),
              { accumulateSentences: false }
            )
      await response.onUpdate(() => {}).await()
      t.is(binding.jobs, (attempt + 1) * 2, 'both native jobs completed')
      t.is(
        response.stats.firstAudioMs,
        values[0],
        'preserves first job latency, including zero, on each response'
      )
    }
  } finally {
    await model.destroy()
  }
}

test('Pocket runStream preserves firstAudioMs across sentences and responses', async (t) => {
  await assertFirstAudioStats(t, 'runStream', [37, 11])
  await assertFirstAudioStats(t, 'runStream', [0, 19])
})

test('Pocket runStreaming preserves firstAudioMs across text inputs and responses', async (t) => {
  await assertFirstAudioStats(t, 'runStreaming', [37, 11])
  await assertFirstAudioStats(t, 'runStreaming', [0, 19])
})
