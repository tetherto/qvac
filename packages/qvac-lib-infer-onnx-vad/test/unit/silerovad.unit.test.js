'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const FakeDL = require('../mocks/loader.fake.js')
const { waitForResponse, wait } = require('../mocks/utils.js')
const { VAD } = require('../../index')
const { SileroVadInterface, setBinding } = require('../../silerovad')
const MockedBinding = require('../mocks/MockedBinding.js')

const process = require('process')
global.process = process
const sinon = require('sinon')

/**
 * @param {*} onOutput Test output callback
 * @param {*} outputCb Base output callback
 */
function createInterfaceClassWithMockedBinding (InterfaceClass, configParams,
  {
    mockedBindings = null,
    onOutput = null,
    outputCb = () => {},
    transitionCb = console.log
  } = {}) {
  const bindings = mockedBindings || new MockedBinding()
  setBinding(bindings)
  if (onOutput) {
    if (!outputCb) {
      outputCb = onOutput
    }
    const originalOutputCb = outputCb
    outputCb = (...args) => {
      onOutput(...args)
      originalOutputCb(...args)
    }
  }
  return new InterfaceClass(configParams, outputCb, transitionCb)
}

const modelFilePath = '/path/to/model.onnx'

function getTestConfigParams () {
  return {
    modelFilePath,
    modeParams: {
      mode: 'batch',
      updateFrequency: 'on_end',
      outputFormat: 'plaintext',
      minSeconds: 2,
      maxSeconds: 29
    }
  }
}

sinon.stub(VAD, '_requireModelFilePath').returns(modelFilePath)

function createMockedModel ({ mockedBindings = null, onOutput = null } = {}) {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    params: getTestConfigParams(),
    config: {
      modelFileName: 'model.onnx'
    }
  }
  const model = new VAD(args)

  sinon.stub(model, '_createAddon').callsFake((interfaceClass, configParams, outputCb, transitionCb) => {
    return createInterfaceClassWithMockedBinding(interfaceClass, configParams, { mockedBindings, onOutput, outputCb: model._outputCallback.bind(model) })
  })

  return model
}

test('Inference returns correct output for audio input', async t => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const model = createMockedModel({ onOutput })
  await model.load()

  const sampleChunk = new Uint8Array([10, 20, 30, 40, 50])
  const jobId1 = await model.addon.append({
    type: 'arrayBuffer',
    input: sampleChunk.buffer
  })
  t.is(jobId1, 1, 'First job ID should be 1')

  const jobIdEnd = await model.addon.append({ type: 'end of job' })
  t.is(jobIdEnd, 1, 'Job ID should remain 1 for end-of-job signal')

  await wait()

  const outputEvent = events.find(e => e.event === 'Output' && e.jobId === 1)
  t.ok(outputEvent, 'Should receive an Output event for the audio chunk')
  t.is(
    outputEvent.output.data,
    sampleChunk.length,
    'Output data should equal the audio chunk length'
  )

  const jobEndedEvent = events.find(
    e => e.event === 'JobEnded' && e.jobId === 1
  )
  t.ok(jobEndedEvent, 'Should receive a JobEnded event for job 1')
})

test('Model state transitions are handled correctly', async t => {
  const model = createMockedModel()
  await model.load()

  const stream = fs.createReadStream('./test/mocks/sample.bin')
  const response = await model.run(stream)
  await waitForResponse(response)

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

  await model.addon.activate()
  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await model.addon.destroy()
  t.ok((await model.status()) === 'idle', 'Status: Model should be idle')
})

test('Model emits error events when an error occurs during processing', async t => {
  const mockedBindings = {
    createInstance: () => Date.now(),
    append: async (handle, data) => {
      throw new Error('Forced error for testing')
    },
    activate: async () => {},
    pause: async () => {},
    stop: async () => {},
    cancel: async () => {},
    status: async () => 'idle',
    destroyInstance: async () => {}
  }
  const model = createMockedModel({ mockedBindings })

  await model.load()

  await t.exception(async () => {
    await model.run('trigger error')
  }, /Forced error for testing/)
})

test('AddonInterface full sequence: status, append, and job boundaries', async t => {
  const events = []
  const onOutput = (addon, event, jobId, output, error) => {
    events.push({ event, jobId, output, error })
  }

  const addon = createInterfaceClassWithMockedBinding(SileroVadInterface, getTestConfigParams(), { onOutput })

  let status = await addon.status()
  t.ok(status === 'loading', 'Initial addon status should be "loading"')

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be "listening" after activation')

  const appendResult1 = await addon.append({
    type: 'arrayBuffer',
    input: new Uint8Array([1, 2, 3]).buffer
  })
  t.ok(appendResult1 === 1, 'Job ID should be 1 for the first appended chunk')

  await wait()
  t.ok(
    events.find(
      e => e.event === 'Output' && e.jobId === 1 && e.output.data === 3
    ),
    'Output callback should report length 3 for audio chunk'
  )

  const appendResult2 = await addon.append({ type: 'end of job' })
  t.ok(appendResult2 === 1, 'Job ID should remain 1 for the end-of-job signal')

  await wait()
  t.ok(
    events.find(
      e =>
        e.event === 'JobEnded' &&
        e.jobId === 1 &&
        e.output.type === 'end of job'
    ),
    'JobEnded callback should be emitted for job 1'
  )

  status = await addon.status()
  t.ok(status === 'listening', 'Status should remain "listening" after job end')

  const appendResult3 = await addon.append({
    type: 'arrayBuffer',
    input: new Uint8Array([4, 5]).buffer
  })
  t.ok(appendResult3 === 2, 'Job ID should increment to 2 for a new job')
  await wait()
  t.ok(
    events.find(
      e => e.event === 'Output' && e.jobId === 2 && e.output.data === 2
    ),
    'Output callback should report length 2 for the first audio chunk of job 2'
  )

  const appendResult4 = await addon.append({
    type: 'arrayBuffer',
    input: new Uint8Array([6, 7, 8, 9]).buffer
  })
  t.ok(appendResult4 === 2, 'Job ID should remain 2 for the same job')
  await wait()
  t.ok(
    events.find(
      e => e.event === 'Output' && e.jobId === 2 && e.output.data === 4
    ),
    'Output callback should report length 4 for the second audio chunk of job 2'
  )

  const appendResult5 = await addon.append({ type: 'end of job' })
  t.ok(
    appendResult5 === 2,
    'Job ID should be 2 for the end-of-job signal of job 2'
  )
  await wait()
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 2),
    'JobEnded callback should be emitted for job 2'
  )

  const appendResult6 = await addon.append({ type: 'end of job' })
  t.ok(
    appendResult6 === 3,
    'Job ID should increment to 3 for a redundant end-of-job signal'
  )
  await wait()
  t.ok(
    events.find(e => e.event === 'JobEnded' && e.jobId === 3),
    'JobEnded callback should be emitted for job 3'
  )

  t.end()
})

test('SileroVadInterface constructor throws if createInstance fails', t => {
  // Mock binding with createInstance returning null
  const mockedBindings = {
    createInstance: () => null
  }
  const { QvacErrorAddonSileroVad, ERR_CODES } = require('../../lib/error')
  const expectedErr = new QvacErrorAddonSileroVad(ERR_CODES.FAILED_TO_CREATE_INSTANCE)
  t.exception(() => {
    createInterfaceClassWithMockedBinding(SileroVadInterface, getTestConfigParams(), { mockedBindings, onOutput: () => {} })
  }, expectedErr)
})
