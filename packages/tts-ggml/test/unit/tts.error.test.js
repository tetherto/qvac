'use strict'

const test = require('brittle')
const { TTSInterface } = require('../../tts.js')
const { QvacErrorAddonTTSGgml, ERR_CODES } = require('../../lib/error.js')

function createErrorBinding (errorMethods = {}) {
  return {
    createInstance: () => ({ id: 1 }),
    activate: (handle) => {
      if (errorMethods.activate) throw new Error(errorMethods.activate)
    },
    runJob: (handle, data) => {
      if (errorMethods.runJob) throw new Error(errorMethods.runJob)
      return true
    },
    cancel: (handle) => {
      if (errorMethods.cancel) throw new Error(errorMethods.cancel)
    },
    destroyInstance: (handle) => {
      if (errorMethods.destroyInstance) throw new Error(errorMethods.destroyInstance)
    },
    loadWeights: (handle, weightsData) => {
      if (errorMethods.loadWeights) throw new Error(errorMethods.loadWeights)
    }
  }
}

test('activate() throws QvacErrorAddonTTSGgml with FAILED_TO_ACTIVATE code', async (t) => {
  const errorMessage = 'Activation failed due to invalid state'
  const binding = createErrorBinding({ activate: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.activate()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTSGgml, 'Error should be instance of QvacErrorAddonTTSGgml')
    t.is(error.code, ERR_CODES.FAILED_TO_ACTIVATE, 'Error code should be FAILED_TO_ACTIVATE')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

test('runJob() throws QvacErrorAddonTTSGgml with FAILED_TO_APPEND code', async (t) => {
  const errorMessage = 'runJob failed'
  const binding = createErrorBinding({ runJob: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.runJob({ type: 'text', input: 'Hello' })
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTSGgml, 'Error should be instance of QvacErrorAddonTTSGgml')
    t.is(error.code, ERR_CODES.FAILED_TO_APPEND, 'Error code should be FAILED_TO_APPEND')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

test('loadWeights() throws QvacErrorAddonTTSGgml with FAILED_TO_LOAD code', async (t) => {
  const errorMessage = 'Load weights failed'
  const binding = createErrorBinding({ loadWeights: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.loadWeights({ filename: 'foo', contents: new Uint8Array(0) })
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTSGgml, 'Error should be instance of QvacErrorAddonTTSGgml')
    t.is(error.code, ERR_CODES.FAILED_TO_LOAD, 'Error code should be FAILED_TO_LOAD')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

test('cancel() throws QvacErrorAddonTTSGgml with FAILED_TO_CANCEL code', async (t) => {
  const errorMessage = 'Cancel operation failed'
  const binding = createErrorBinding({ cancel: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.cancel()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTSGgml, 'Error should be instance of QvacErrorAddonTTSGgml')
    t.is(error.code, ERR_CODES.FAILED_TO_CANCEL, 'Error code should be FAILED_TO_CANCEL')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

test('cancel() calls native binding with the addon handle only', async (t) => {
  const calls = []
  const binding = createErrorBinding()
  binding.cancel = function () {
    calls.push(Array.from(arguments))
  }
  const tts = new TTSInterface(binding, {})

  await tts.cancel()

  t.is(calls.length, 1, 'cancel should call the native binding once')
  t.is(calls[0].length, 1, 'cancel should not forward a jobId argument')
  t.alike(calls[0][0], tts._handle, 'cancel should forward the addon handle')
})

test('destroyInstance() throws QvacErrorAddonTTSGgml with FAILED_TO_DESTROY code', async (t) => {
  const errorMessage = 'Failed to destroy instance'
  const binding = createErrorBinding({ destroyInstance: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.destroyInstance()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTSGgml, 'Error should be instance of QvacErrorAddonTTSGgml')
    t.is(error.code, ERR_CODES.FAILED_TO_DESTROY, 'Error code should be FAILED_TO_DESTROY')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

test('destroyInstance() returns early if handle is null', async (t) => {
  const binding = createErrorBinding({ destroyInstance: 'Should not be called' })
  const tts = new TTSInterface(binding, {})

  // Manually set handle to null
  tts._handle = null

  // Should not throw
  await tts.destroyInstance()
  t.pass('destroyInstance should return early without error when handle is null')
})

test('unload() delegates to destroyInstance and preserves errors', async (t) => {
  const errorMessage = 'Destroy failed during unload'
  const binding = createErrorBinding({ destroyInstance: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.unload()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTSGgml, 'Error should be instance of QvacErrorAddonTTSGgml')
    t.is(error.code, ERR_CODES.FAILED_TO_DESTROY, 'Error code should be FAILED_TO_DESTROY')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

test('Error cause is preserved in QvacErrorAddonTTSGgml', async (t) => {
  const errorMessage = 'Original error message'
  const binding = createErrorBinding({ activate: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.activate()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error.cause, 'Error should have a cause property')
    t.ok(error.cause instanceof Error, 'Cause should be an Error instance')
    t.is(error.cause.message, errorMessage, 'Cause message should match original error')
  }
})

test('All ERR_CODES are defined and unique', async (t) => {
  const codes = Object.values(ERR_CODES)
  const uniqueCodes = new Set(codes)

  t.is(codes.length, 11, 'Should have 11 error codes')
  t.is(uniqueCodes.size, codes.length, 'All error codes should be unique')

  // Range 13001-14000 is reserved for @qvac/tts-ggml (see lib/error.js).
  t.is(ERR_CODES.FAILED_TO_ACTIVATE, 13001, 'FAILED_TO_ACTIVATE should be 13001')
  t.is(ERR_CODES.FAILED_TO_APPEND, 13002, 'FAILED_TO_APPEND should be 13002')
  t.is(ERR_CODES.FAILED_TO_GET_STATUS, 13003, 'FAILED_TO_GET_STATUS should be 13003')
  t.is(ERR_CODES.FAILED_TO_PAUSE, 13004, 'FAILED_TO_PAUSE should be 13004')
  t.is(ERR_CODES.FAILED_TO_CANCEL, 13005, 'FAILED_TO_CANCEL should be 13005')
  t.is(ERR_CODES.FAILED_TO_DESTROY, 13006, 'FAILED_TO_DESTROY should be 13006')
  t.is(ERR_CODES.FAILED_TO_UNLOAD, 13007, 'FAILED_TO_UNLOAD should be 13007')
  t.is(ERR_CODES.FAILED_TO_LOAD, 13008, 'FAILED_TO_LOAD should be 13008')
  t.is(ERR_CODES.FAILED_TO_RELOAD, 13009, 'FAILED_TO_RELOAD should be 13009')
  t.is(ERR_CODES.FAILED_TO_STOP, 13010, 'FAILED_TO_STOP should be 13010')
  t.is(ERR_CODES.JOB_ALREADY_RUNNING, 13011, 'JOB_ALREADY_RUNNING should be 13011')
})
