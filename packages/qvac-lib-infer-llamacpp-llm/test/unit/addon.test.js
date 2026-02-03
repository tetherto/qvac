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
