'use strict'

const test = require('brittle')
const FakeDL = require('../mocks/loader.fake')
const config = require('../mocks/test.config.json')
const MockBindings = require('../mocks/MockBindings')
const LlmLlamacpp = require('../../index')
const { LlamaInterface } = require('../../addon')
const { transitionCb, wait } = require('../mocks/utils.js')

const process = require('process')
global.process = process
const sinon = require('sinon')

function createMockedModel (mockedBindings = undefined) {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    params: { mode: 'full' },
    opts: {},
    modelName: 'fakeModel-00001-of-00005.gguf'
  }
  const model = new LlmLlamacpp(args, config)
  sinon.stub(model, '_createAddon').callsFake(configParams => {
    if (mockedBindings) {
      return mockedBindings
    }
    const bindings = new MockBindings()
    return new LlamaInterface(bindings, configParams, model._outputCallback.bind(model), console.log)
  })
  return model
}

test('can get inference output for the input and finish processing', async t => {
  const model = createMockedModel()
  await model.load()

  const text = [{ content: 'test input text', role: 'user' }]
  const response = await model.run(text)
  response.onUpdate(data => {
    t.alike(data, { type: 'number', data: JSON.stringify(text).length })
  })
  await response.await()
})

test('Model state transitions are handled correctly', async (t) => {
  const model = createMockedModel()
  await model.load()

  const response = await model.run([{ content: 'hello world', role: 'user' }])
  await response.await()

  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await model.pause()
  t.ok((await model.status()) === 'paused', 'Status: Model should be paused')

  await model.unpause()
  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await model.stop()
  t.ok((await model.status()) === 'stopped', 'Status: Model should be stopped')

  await model.addon.activate()
  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await model.addon.destroyInstance()
  t.ok((await model.status()) === 'idle', 'Status: Model should be idle')
})

test('Model emits error events when an error occurs during processing', async (t) => {
  const mockedBindings = {
    append: async ({ type, input }) => {
      throw new Error('Forced error for testing')
    },
    loadWeights: async () => { },
    activate: async () => { },
    pause: async () => { },
    stop: async () => { },
    cancel: async () => { },
    status: async () => 'idle',
    progress: async () => ({ processed: 0, total: 0 }),
    destroy: async () => { }
  }
  const model = createMockedModel(mockedBindings)

  await model.load()

  let errorCaught = false
  try {
    await model.run([{ content: 'trigger error', role: 'user' }])
  } catch (err) {
    errorCaught = true
    t.is(err.message, 'Forced error for testing')
  }
  t.ok(errorCaught, 'Error event should be caught')
})

test('FakeDL returns correct file list and data buffers', async (t) => {
  const fakeDL = new FakeDL({})

  const fileList = await fakeDL.list('/')
  t.alike(
    fileList.sort(),
    ['1.bin', '2.bin', 'conf.json', 'mlc-chat-config.json', 'generation_config.json'].sort(),
    'File list should match expected files'
  )

  for (const file of fileList) {
    const buffer = await fakeDL.getStream(file)
    t.ok(Buffer.isBuffer(buffer), `getStream should return a Buffer for ${file}`)
    t.ok(buffer.length > 0, `Buffer for ${file} should contain data`)
  }
})

test('AddonInterface full sequence: status, append, and job boundaries', async (t) => {
  const events = []
  const outputCb = (instance, eventType, jobId, data, extra) => {
    console.log(
      `Callback for job ${jobId} with event ${eventType}: ${JSON.stringify(
        data
      )}`
    )
    events.push({ eventType, jobId, data })
  }

  const binding = new MockBindings()
  const addon = new LlamaInterface(binding, {}, outputCb, transitionCb)

  let status = await addon.status()
  t.ok(status === 'loading', 'Initial addon status should be "loading"')

  await addon.loadWeights({ dummy: 'weightsData' })

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be "listening" after activation')

  // Append a message and verify the returned job ID
  const message1 = [{ content: 'Hello, how are you?', role: 'user' }]
  const appendResult1 = await addon.append({ type: 'text', input: message1 })
  t.ok(appendResult1 === 1, 'Job ID should be 1 for the first appended message')

  // Wait for the output callback to be triggered and verify output data
  await wait()
  t.ok(
    events.find(
      (e) => e.eventType === 'Output' && e.jobId === 1 && e.data.type === 'number'
    ),
    'Output callback should report a number for the first message'
  )

  const appendResult2 = await addon.append({ type: 'end of job' })
  t.ok(appendResult2 === 1, 'Job ID should remain 1 for the end-of-job signal')
  await wait()
  t.ok(
    events.find(
      (e) =>
        e.eventType === 'JobEnded' &&
        e.jobId === 1 &&
        e.data.type === 'end of job'
    ),
    'JobEnded callback should be emitted for job 1'
  )

  status = await addon.status()
  t.ok(
    status === 'listening',
    'Status should remain "listening" after job end'
  )

  // Append a message with a priority, which should start a new job
  const message2 = [{ content: 'What is the weather like?', role: 'user' }]
  const appendResult3 = await addon.append({
    type: 'text',
    input: message2,
    priority: 49
  })
  t.ok(
    appendResult3 === 2,
    'Job ID should increment to 2 for a new job with priority'
  )
  await wait()
  t.ok(
    events.find(
      (e) => e.eventType === 'Output' && e.jobId === 2 && e.data.type === 'number'
    ),
    'Output callback should report a number for the second message'
  )

  // Append another message; it should belong to the current job (job 2)
  const message3 = [{ content: 'Can you help me with that?', role: 'user' }]
  const appendResult4 = await addon.append({ type: 'text', input: message3 })
  t.ok(appendResult4 === 2, 'Job ID should remain 2 for the same job')
  await wait()
  t.ok(
    events.find(
      (e) => e.eventType === 'Output' && e.jobId === 2 && e.data.type === 'number'
    ),
    'Output callback should report a number for the third message'
  )

  // Append end-of-job signal for job 2
  const appendResult5 = await addon.append({ type: 'end of job' })
  t.ok(
    appendResult5 === 2,
    'Job ID should be 2 for the end-of-job signal of job 2'
  )
  await wait()
  t.ok(
    events.find((e) => e.eventType === 'JobEnded' && e.jobId === 2),
    'JobEnded callback should be emitted for job 2'
  )

  // Append a redundant end-of-job marker; this should start a new job (job 3)
  const appendResult6 = await addon.append({ type: 'end of job' })
  t.ok(
    appendResult6 === 3,
    'Job ID should increment to 3 for a redundant end-of-job signal'
  )
  await wait()
  t.ok(
    events.find((e) => e.eventType === 'JobEnded' && e.jobId === 3),
    'JobEnded callback should be emitted for job 3'
  )

  t.end()
})

test('_withExclusiveRun serializes concurrent run calls', async t => {
  const model = createMockedModel()
  await model.load()

  const executionOrder = []
  const originalAppend = model.addon.append.bind(model.addon)
  const activeRuns = new Set()

  model.addon.append = async (data) => {
    if (data.type === 'text') {
      const content = JSON.parse(data.input)[0].content
      if (!activeRuns.has(content)) {
        activeRuns.add(content)
        executionOrder.push(`start-${content}`)
        await new Promise(resolve => setTimeout(resolve, 30))
      }
    }
    const result = await originalAppend(data)
    if (data.type === 'text') {
      const content = JSON.parse(data.input)[0].content
      if (activeRuns.has(content)) {
        executionOrder.push(`end-${content}`)
        activeRuns.delete(content)
      }
    }
    return result
  }

  const promises = [
    model.run([{ content: 'first', role: 'user' }]),
    model.run([{ content: 'second', role: 'user' }]),
    model.run([{ content: 'third', role: 'user' }])
  ]

  await Promise.all(promises)

  const start1 = executionOrder.indexOf('start-first')
  const end1 = executionOrder.indexOf('end-first')
  const start2 = executionOrder.indexOf('start-second')
  const end2 = executionOrder.indexOf('end-second')
  const start3 = executionOrder.indexOf('start-third')

  t.ok(end1 < start2, 'First run should complete before second starts')
  t.ok(end2 < start3, 'Second run should complete before third starts')
  t.ok(start1 < start2 && start2 < start3, 'Runs should execute in order')
})

test('_withExclusiveRun handles errors correctly and releases queue', async t => {
  const model = createMockedModel()
  await model.load()

  let callCount = 0
  model.addon.append = async (data) => {
    callCount++
    if (callCount === 1) {
      throw new Error('First call fails')
    }
    return callCount
  }

  try {
    await model.run([{ content: 'fail', role: 'user' }])
    t.fail('Should have thrown error')
  } catch (err) {
    t.is(err.message, 'First call fails')
  }

  const response = await model.run([{ content: 'success', role: 'user' }])
  t.ok(response, 'Second call should succeed after first fails')
})

test('_runInternal processes media messages correctly', async t => {
  const model = createMockedModel()
  await model.load()

  const appendCalls = []
  const originalAppend = model.addon.append.bind(model.addon)
  model.addon.append = async (data) => {
    appendCalls.push({ ...data })
    return originalAppend(data)
  }

  const mediaData = new Uint8Array([1, 2, 3, 4, 5])
  const prompt = [
    { role: 'user', type: 'media', content: mediaData },
    { role: 'user', content: 'Describe this image' }
  ]

  await model.run(prompt)

  const mediaCall = appendCalls.find(c => c.type === 'media')
  t.ok(mediaCall, 'Media should be sent as separate append call')
  t.ok(mediaCall.input instanceof Uint8Array, 'Media input should be Uint8Array')
  t.alike(Array.from(mediaCall.input), Array.from(mediaData), 'Media data should match')

  const textCall = appendCalls.find(c => c.type === 'text')
  t.ok(textCall, 'Text prompt should be sent')
  const parsedPrompt = JSON.parse(textCall.input)
  t.is(parsedPrompt[0].content, '', 'Media message content should be empty string')
  t.is(parsedPrompt[0].type, 'media', 'Media message type should be preserved')
  t.is(parsedPrompt[1].content, 'Describe this image', 'Second message should be unchanged')
})

test('_runInternal handles media append errors gracefully', async t => {
  const model = createMockedModel()
  await model.load()

  let mediaCallCount = 0
  let textAppendCalled = false
  const originalAppend = model.addon.append.bind(model.addon)
  model.addon.append = async (data) => {
    if (data.type === 'media') {
      mediaCallCount++
      throw new Error('Media append failed')
    }
    if (data.type === 'text') {
      textAppendCalled = true
    }
    return originalAppend(data)
  }

  const logSpy = sinon.spy(model.logger, 'error')
  const mediaData = new Uint8Array([1, 2, 3])

  await model.run([
    { role: 'user', type: 'media', content: mediaData },
    { role: 'user', content: 'Continue anyway' }
  ])

  t.ok(logSpy.called, 'Error should be logged')
  t.ok(logSpy.firstCall.args[0].includes('Failed to send media data'), 'Error message should mention media')
  t.is(mediaCallCount, 1, 'Media append should have been attempted')
  t.ok(textAppendCalled, 'Text prompt should still be sent despite media error')
})

test('_runInternal serializes prompt correctly', async t => {
  const model = createMockedModel()
  await model.load()

  const appendCalls = []
  const originalAppend = model.addon.append.bind(model.addon)
  model.addon.append = async (data) => {
    if (data.type === 'text') {
      appendCalls.push(data)
    }
    return originalAppend(data)
  }

  const prompt = [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' }
  ]

  await model.run(prompt)

  t.is(appendCalls.length, 1, 'Should have one text append call')
  const parsed = JSON.parse(appendCalls[0].input)
  t.alike(parsed, prompt, 'Serialized prompt should match original')
})

test('_load builds configuration params correctly', async t => {
  const fakeDL = new FakeDL({})
  const config = { gpu_layers: '10', ctx_size: '2048', device: 'cpu' }

  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/test/path',
    modelName: 'test-model.gguf',
    projectionModel: 'test-projection.gguf'
  }, config)

  sinon.stub(model, 'downloadWeights').resolves()

  let capturedConfigParams = null
  sinon.stub(model, '_createAddon').callsFake((configParams) => {
    capturedConfigParams = configParams
    return {
      activate: async () => {}
    }
  })

  await model._load(false, () => {})

  t.ok(model._createAddon.calledOnce, '_createAddon should be called once')
  t.ok(capturedConfigParams !== null, 'Config params should be captured')

  t.ok(capturedConfigParams.path.includes('/test/path'), 'Path should include diskPath')
  t.ok(capturedConfigParams.path.includes('test-model.gguf'), 'Path should include modelName')
  t.ok(capturedConfigParams.projectionPath.includes('/test/path'), 'ProjectionPath should include diskPath')
  t.ok(capturedConfigParams.projectionPath.includes('test-projection.gguf'), 'ProjectionPath should include projectionModel')
  t.alike(capturedConfigParams.config, config, 'Config should be passed through')
})

test('_load builds configuration params without projection model', async t => {
  const fakeDL = new FakeDL({})
  const config = { gpu_layers: '10', device: 'cpu' }

  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/test',
    modelName: 'model.gguf'
  }, config)

  let capturedConfigParams = null
  sinon.stub(model, 'downloadWeights').resolves()
  sinon.stub(model, '_createAddon').callsFake((configParams) => {
    capturedConfigParams = configParams
    return {
      activate: async () => {}
    }
  })

  await model._load(false, () => {})

  t.is(capturedConfigParams.projectionPath, '', 'ProjectionPath should be empty string when no projection model')
  t.ok(capturedConfigParams.path.includes('model.gguf'), 'Path should include modelName')
})

test('_load handles sharded model path correctly', async t => {
  const fakeDL = new FakeDL({})
  const config = { device: 'cpu' }

  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/models',
    modelName: 'model-00001-of-00005.gguf'
  }, config)

  t.ok(model._shards !== null, 'Shards should be detected for sharded model')

  const loadWeightsSpy = sinon.spy(model, '_loadWeights')
  let capturedConfigParams = null
  const mockAddon = {
    activate: async () => {},
    loadWeights: async () => {}
  }
  sinon.stub(model, '_createAddon').callsFake((configParams) => {
    capturedConfigParams = configParams
    model.addon = mockAddon
    return mockAddon
  })
  sinon.stub(model.weightsProvider, 'streamFiles').resolves()

  await model._load(false, () => {})

  t.ok(model._createAddon.calledOnce, '_createAddon should be called')
  t.ok(loadWeightsSpy.calledOnce, '_loadWeights should be called for sharded model')

  t.ok(capturedConfigParams.path.includes('model-00001-of-00005.gguf'), 'Path should include sharded model name')
})

test('_load handles non-sharded model path correctly', async t => {
  const fakeDL = new FakeDL({})
  const config = { device: 'cpu' }

  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/models',
    modelName: 'model.gguf'
  }, config)

  t.is(model._shards, null, 'Shards should be null for non-sharded model')

  const downloadWeightsStub = sinon.stub(model, 'downloadWeights').resolves()
  sinon.stub(model, '_createAddon').callsFake((configParams) => {
    return {
      activate: async () => {}
    }
  })

  await model._load(false, () => {})

  t.ok(model._createAddon.calledOnce, '_createAddon should be called')
  t.ok(downloadWeightsStub.calledOnce, 'downloadWeights should be called for non-sharded model')
})

test('_load propagates errors correctly', async t => {
  const fakeDL = new FakeDL({})
  const model = new LlmLlamacpp({
    loader: fakeDL,
    modelName: 'test.gguf'
  }, {})

  const testError = new Error('Load failed')
  sinon.stub(model, 'downloadWeights').resolves()
  sinon.stub(model, '_createAddon').throws(testError)

  const logSpy = sinon.spy(model.logger, 'error')

  try {
    await model._load(false, () => {})
    t.fail('Should have thrown error')
  } catch (err) {
    t.is(err, testError, 'Error should be propagated')
    t.ok(logSpy.called, 'Error should be logged')
    t.ok(logSpy.firstCall.args[0].includes('Error during model load'), 'Log should mention load error')
  }
})

test('_downloadWeights downloads single model', async t => {
  const fakeDL = new FakeDL({})
  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/test/path',
    modelName: 'model.gguf'
  }, {})

  const downloadFilesStub = sinon.stub(model.weightsProvider, 'downloadFiles').resolves([])
  const progressCallback = sinon.spy()

  await model._downloadWeights(progressCallback, { closeLoader: true })

  t.ok(downloadFilesStub.calledOnce, 'downloadFiles should be called once')
  const callArgs = downloadFilesStub.firstCall.args
  t.alike(callArgs[0], ['model.gguf'], 'Should download single model file')
  t.is(callArgs[1], '/test/path', 'Should use correct diskPath')
  t.is(callArgs[2].closeLoader, true, 'Should pass closeLoader option')
  t.is(callArgs[2].onDownloadProgress, progressCallback, 'Should pass progress callback')
})

test('_downloadWeights downloads model with projection', async t => {
  const fakeDL = new FakeDL({})
  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/test/path',
    modelName: 'model.gguf',
    projectionModel: 'projection.gguf'
  }, {})

  const downloadFilesStub = sinon.stub(model.weightsProvider, 'downloadFiles').resolves([])
  const progressCallback = sinon.spy()

  await model._downloadWeights(progressCallback, { closeLoader: false })

  t.ok(downloadFilesStub.calledOnce, 'downloadFiles should be called once')
  const callArgs = downloadFilesStub.firstCall.args
  t.alike(callArgs[0], ['model.gguf', 'projection.gguf'], 'Should download both model and projection')
  t.is(callArgs[1], '/test/path', 'Should use correct diskPath')
  t.is(callArgs[2].closeLoader, false, 'Should pass closeLoader option')
  t.is(callArgs[2].onDownloadProgress, progressCallback, 'Should pass progress callback')
})

test('_loadWeights streams sharded weights correctly', async t => {
  const fakeDL = new FakeDL({})
  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/test/path',
    modelName: 'model-00001-of-00003.gguf'
  }, {})

  t.ok(model._shards !== null, 'Shards should be detected')

  const mockAddon = {
    loadWeights: sinon.spy()
  }
  model.addon = mockAddon

  const streamFilesStub = sinon.stub(model.weightsProvider, 'streamFiles')
  const progressCallback = sinon.spy()
  const chunkedData = [
    { filename: 'model-00001-of-00003.gguf', contents: new Uint8Array([1, 2, 3]), completed: false },
    { filename: 'model-00002-of-00003.gguf', contents: new Uint8Array([4, 5, 6]), completed: false },
    { filename: 'model-00003-of-00003.gguf', contents: new Uint8Array([7, 8, 9]), completed: true }
  ]

  streamFilesStub.callsFake(async (shards, onChunk, progressCb) => {
    for (const chunk of chunkedData) {
      await onChunk(chunk)
    }
  })

  await model._loadWeights(progressCallback)

  t.ok(streamFilesStub.calledOnce, 'streamFiles should be called once')
  t.ok(streamFilesStub.calledWith(model._shards), 'Should pass shards to streamFiles')
  t.is(streamFilesStub.firstCall.args[2], progressCallback, 'Should pass progress callback')

  t.is(mockAddon.loadWeights.callCount, 3, 'loadWeights should be called for each chunk')
  t.alike(mockAddon.loadWeights.firstCall.args[0], chunkedData[0], 'First chunk should match')
  t.alike(mockAddon.loadWeights.secondCall.args[0], chunkedData[1], 'Second chunk should match')
  t.alike(mockAddon.loadWeights.thirdCall.args[0], chunkedData[2], 'Third chunk should match')
})

test('downloadWeights public method calls _downloadWeights correctly', async t => {
  const fakeDL = new FakeDL({})
  const model = new LlmLlamacpp({
    loader: fakeDL,
    diskPath: '/test/path',
    modelName: 'model.gguf'
  }, {})

  const downloadFilesStub = sinon.stub(model.weightsProvider, 'downloadFiles')
  downloadFilesStub.resolves([{ filePath: '/test/path/model.gguf', completed: true, error: false }])
  const _downloadWeightsSpy = sinon.spy(model, '_downloadWeights')

  const progressCallback = sinon.spy()
  await model.downloadWeights(progressCallback, { closeLoader: true })

  t.ok(_downloadWeightsSpy.calledOnce, '_downloadWeights should be called')
  t.is(_downloadWeightsSpy.firstCall.args[0], progressCallback, 'Should pass progress callback')
  t.is(_downloadWeightsSpy.firstCall.args[1].closeLoader, true, 'Should pass closeLoader option')
})

test('cancel method cancels specific job by jobId', async t => {
  const model = createMockedModel()
  await model.load()

  const cancelSpy = sinon.spy(model.addon, 'cancel')
  const jobId = 5

  await model.addon.cancel(jobId)

  t.ok(cancelSpy.calledOnce, 'cancel should be called once')
  t.is(cancelSpy.firstCall.args[0], jobId, 'Should pass correct jobId')
})

test('cancel method cancels all jobs when no jobId provided', async t => {
  const model = createMockedModel()
  await model.load()

  const cancelSpy = sinon.spy(model.addon, 'cancel')

  await model.addon.cancel()

  t.ok(cancelSpy.calledOnce, 'cancel should be called once')
  t.is(cancelSpy.firstCall.args[0], undefined, 'Should be called without jobId')
})

test('addon unload method destroys instance', async t => {
  const binding = new MockBindings()
  const addon = new LlamaInterface(binding, {}, () => {}, transitionCb)

  await addon.loadWeights({ dummy: 'data' })
  await addon.activate()

  t.ok(addon._handle !== null, 'Handle should exist before unload')
  const destroyInstanceSpy = sinon.spy(binding, 'destroyInstance')

  await addon.unload()

  t.ok(destroyInstanceSpy.calledOnce, 'destroyInstance should be called on binding')
  t.is(addon._handle, null, 'Handle should be null after unload')
})

test('addon unload method is idempotent', async t => {
  const binding = new MockBindings()
  const addon = new LlamaInterface(binding, {}, () => {}, transitionCb)

  await addon.loadWeights({ dummy: 'data' })
  await addon.activate()

  const destroyInstanceSpy = sinon.spy(binding, 'destroyInstance')

  await addon.unload()
  t.ok(destroyInstanceSpy.calledOnce, 'First unload should call destroyInstance')
  t.is(addon._handle, null, 'Handle should be null after first unload')

  await addon.unload()
  t.ok(destroyInstanceSpy.calledOnce, 'Second unload should not call destroyInstance again (idempotent)')
  t.is(addon._handle, null, 'Handle should remain null after second unload')
})
