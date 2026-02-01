'use strict'

const test = require('brittle')
const { TTSInterface } = require('../../tts.js')
const { QvacErrorAddonTTS, ERR_CODES } = require('../../lib/error.js')

const process = require('process')
global.process = process

/**
 * Creates a mock binding that throws errors for specified methods
 * @param {Object} errorMethods - Object with method names as keys and error messages as values
 */
function createErrorBinding (errorMethods = {}) {
  return {
    createInstance: () => ({ id: 1 }),
    activate: (handle) => {
      if (errorMethods.activate) throw new Error(errorMethods.activate)
    },
    append: (handle, data) => {
      if (errorMethods.append) throw new Error(errorMethods.append)
      return 1
    },
    status: (handle) => {
      if (errorMethods.status) throw new Error(errorMethods.status)
      return 'listening'
    },
    pause: (handle) => {
      if (errorMethods.pause) throw new Error(errorMethods.pause)
    },
    stop: (handle) => {
      if (errorMethods.stop) throw new Error(errorMethods.stop)
    },
    cancel: (handle, jobId) => {
      if (errorMethods.cancel) throw new Error(errorMethods.cancel)
    },
    destroyInstance: (handle) => {
      if (errorMethods.destroyInstance) throw new Error(errorMethods.destroyInstance)
    },
    unload: (handle) => {
      if (errorMethods.unload) throw new Error(errorMethods.unload)
    },
    load: (handle, config) => {
      if (errorMethods.load) throw new Error(errorMethods.load)
    },
    reload: (handle, config) => {
      if (errorMethods.reload) throw new Error(errorMethods.reload)
    }
  }
}

/**
 * Test that activate() throws QvacErrorAddonTTS with FAILED_TO_ACTIVATE code
 */
test('activate() throws QvacErrorAddonTTS with FAILED_TO_ACTIVATE code', async (t) => {
  const errorMessage = 'Activation failed due to invalid state'
  const binding = createErrorBinding({ activate: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.activate()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_ACTIVATE, 'Error code should be FAILED_TO_ACTIVATE')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that append() throws QvacErrorAddonTTS with FAILED_TO_APPEND code
 */
test('append() throws QvacErrorAddonTTS with FAILED_TO_APPEND code', async (t) => {
  const errorMessage = 'Append failed due to queue overflow'
  const binding = createErrorBinding({ append: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.append({ type: 'text', input: 'Hello' })
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_APPEND, 'Error code should be FAILED_TO_APPEND')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that status() throws QvacErrorAddonTTS with FAILED_TO_GET_STATUS code
 */
test('status() throws QvacErrorAddonTTS with FAILED_TO_GET_STATUS code', async (t) => {
  const errorMessage = 'Status unavailable'
  const binding = createErrorBinding({ status: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.status()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_GET_STATUS, 'Error code should be FAILED_TO_GET_STATUS')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that pause() throws QvacErrorAddonTTS with FAILED_TO_PAUSE code
 */
test('pause() throws QvacErrorAddonTTS with FAILED_TO_PAUSE code', async (t) => {
  const errorMessage = 'Cannot pause in current state'
  const binding = createErrorBinding({ pause: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.pause()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_PAUSE, 'Error code should be FAILED_TO_PAUSE')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that stop() throws QvacErrorAddonTTS with FAILED_TO_STOP code
 */
test('stop() throws QvacErrorAddonTTS with FAILED_TO_STOP code', async (t) => {
  const errorMessage = 'Stop operation failed'
  const binding = createErrorBinding({ stop: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.stop()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_STOP, 'Error code should be FAILED_TO_STOP')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that cancel() throws QvacErrorAddonTTS with FAILED_TO_CANCEL code
 */
test('cancel() throws QvacErrorAddonTTS with FAILED_TO_CANCEL code', async (t) => {
  const errorMessage = 'Cancel operation failed'
  const binding = createErrorBinding({ cancel: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.cancel(1)
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_CANCEL, 'Error code should be FAILED_TO_CANCEL')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that destroyInstance() throws QvacErrorAddonTTS with FAILED_TO_DESTROY code
 */
test('destroyInstance() throws QvacErrorAddonTTS with FAILED_TO_DESTROY code', async (t) => {
  const errorMessage = 'Failed to destroy instance'
  const binding = createErrorBinding({ destroyInstance: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.destroyInstance()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_DESTROY, 'Error code should be FAILED_TO_DESTROY')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that destroyInstance() returns early if already destroyed
 */
test('destroyInstance() returns early if handle is null', async (t) => {
  const binding = createErrorBinding({ destroyInstance: 'Should not be called' })
  const tts = new TTSInterface(binding, {})

  // Manually set handle to null
  tts._handle = null

  // Should not throw
  await tts.destroyInstance()
  t.pass('destroyInstance should return early without error when handle is null')
})

/**
 * Test that unload() throws QvacErrorAddonTTS with FAILED_TO_UNLOAD code
 */
test('unload() throws QvacErrorAddonTTS with FAILED_TO_UNLOAD code', async (t) => {
  const errorMessage = 'Unload operation failed'
  const binding = createErrorBinding({ unload: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.unload()
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_UNLOAD, 'Error code should be FAILED_TO_UNLOAD')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that load() throws QvacErrorAddonTTS with FAILED_TO_LOAD code
 */
test('load() throws QvacErrorAddonTTS with FAILED_TO_LOAD code', async (t) => {
  const errorMessage = 'Load operation failed'
  const binding = createErrorBinding({ load: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.load({ modelPath: './model.onnx' })
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_LOAD, 'Error code should be FAILED_TO_LOAD')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that reload() throws QvacErrorAddonTTS with FAILED_TO_RELOAD code
 */
test('reload() throws QvacErrorAddonTTS with FAILED_TO_RELOAD code', async (t) => {
  const errorMessage = 'Reload operation failed'
  const binding = createErrorBinding({ reload: errorMessage })
  const tts = new TTSInterface(binding, {})

  try {
    await tts.reload({ modelPath: './model.onnx' })
    t.fail('Should have thrown an error')
  } catch (error) {
    t.ok(error instanceof QvacErrorAddonTTS, 'Error should be instance of QvacErrorAddonTTS')
    t.is(error.code, ERR_CODES.FAILED_TO_RELOAD, 'Error code should be FAILED_TO_RELOAD')
    t.ok(error.message.includes(errorMessage), 'Error message should contain original error')
  }
})

/**
 * Test that error cause is preserved
 */
test('Error cause is preserved in QvacErrorAddonTTS', async (t) => {
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

/**
 * Test all ERR_CODES are defined and unique
 */
test('All ERR_CODES are defined and unique', async (t) => {
  const codes = Object.values(ERR_CODES)
  const uniqueCodes = new Set(codes)

  t.is(codes.length, 10, 'Should have 10 error codes')
  t.is(uniqueCodes.size, codes.length, 'All error codes should be unique')

  // Verify code range
  t.is(ERR_CODES.FAILED_TO_ACTIVATE, 7001, 'FAILED_TO_ACTIVATE should be 7001')
  t.is(ERR_CODES.FAILED_TO_APPEND, 7002, 'FAILED_TO_APPEND should be 7002')
  t.is(ERR_CODES.FAILED_TO_GET_STATUS, 7003, 'FAILED_TO_GET_STATUS should be 7003')
  t.is(ERR_CODES.FAILED_TO_PAUSE, 7004, 'FAILED_TO_PAUSE should be 7004')
  t.is(ERR_CODES.FAILED_TO_CANCEL, 7005, 'FAILED_TO_CANCEL should be 7005')
  t.is(ERR_CODES.FAILED_TO_DESTROY, 7006, 'FAILED_TO_DESTROY should be 7006')
  t.is(ERR_CODES.FAILED_TO_UNLOAD, 7007, 'FAILED_TO_UNLOAD should be 7007')
  t.is(ERR_CODES.FAILED_TO_LOAD, 7008, 'FAILED_TO_LOAD should be 7008')
  t.is(ERR_CODES.FAILED_TO_RELOAD, 7009, 'FAILED_TO_RELOAD should be 7009')
  t.is(ERR_CODES.FAILED_TO_STOP, 7010, 'FAILED_TO_STOP should be 7010')
})
