'use strict'

const test = require('brittle')
const { QvacErrorAddonOcr, ERR_CODES } = require('../../lib/error')

/**
 * Test that all error codes are defined.
 */
test('All 16 OCR error codes are defined', async t => {
  const expectedCodes = {
    FAILED_TO_LOAD_WEIGHTS: 9001,
    FAILED_TO_ACTIVATE: 9002,
    FAILED_TO_PAUSE: 9003,
    FAILED_TO_APPEND: 9004,
    FAILED_TO_GET_STATUS: 9005,
    FAILED_TO_DESTROY: 9006,
    INVALID_BMP_OR_INSUFFICIENT_DATA: 9007,
    INVALID_BMP_FILE: 9008,
    INCOMPLETE_BMP_DATA: 9009,
    UNSUPPORTED_BMP_HEADER_SIZE: 9010,
    INVALID_BMP_PIXEL_DATA: 9011,
    MISSING_REQUIRED_PARAMETER: 9012,
    UNSUPPORTED_IMAGE_FORMAT: 9013,
    IMAGE_DECODE_FAILED: 9014,
    UNSUPPORTED_LANGUAGE: 9015,
    FAILED_TO_RUN_JOB: 9016
  }

  for (const [name, code] of Object.entries(expectedCodes)) {
    t.is(ERR_CODES[name], code, `ERR_CODES.${name} should be ${code}`)
  }

  t.is(Object.keys(expectedCodes).length, 16, 'Should have exactly 16 error codes')
})

/**
 * Test that ERR_CODES is frozen (immutable).
 */
test('ERR_CODES object is frozen', async t => {
  t.ok(Object.isFrozen(ERR_CODES), 'ERR_CODES should be frozen')
})

/**
 * Test that QvacErrorAddonOcr can be instantiated with each error code.
 */
test('QvacErrorAddonOcr creates error with FAILED_TO_LOAD_WEIGHTS code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS, adds: 'model file corrupt' })
  t.is(err.code, 9001, 'Error code should be 9001')
  t.ok(err.message.includes('model file corrupt'), 'Error message should contain the adds parameter')
  t.ok(err.message.includes('Failed to load weights'), 'Error message should contain the base message')
})

test('QvacErrorAddonOcr creates error with FAILED_TO_ACTIVATE code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_ACTIVATE, adds: 'invalid state' })
  t.is(err.code, 9002, 'Error code should be 9002')
  t.ok(err.message.includes('invalid state'), 'Error message should contain the adds parameter')
  t.ok(err.message.includes('Failed to activate'), 'Error message should contain the base message')
})

test('QvacErrorAddonOcr creates error with FAILED_TO_PAUSE code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_PAUSE, adds: 'not running' })
  t.is(err.code, 9003, 'Error code should be 9003')
  t.ok(err.message.includes('not running'), 'Error message should contain the adds parameter')
})

test('QvacErrorAddonOcr creates error with FAILED_TO_APPEND code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_APPEND, adds: 'queue full' })
  t.is(err.code, 9004, 'Error code should be 9004')
  t.ok(err.message.includes('queue full'), 'Error message should contain the adds parameter')
})

test('QvacErrorAddonOcr creates error with FAILED_TO_GET_STATUS code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_GET_STATUS, adds: 'handle invalid' })
  t.is(err.code, 9005, 'Error code should be 9005')
  t.ok(err.message.includes('handle invalid'), 'Error message should contain the adds parameter')
})

test('QvacErrorAddonOcr creates error with FAILED_TO_DESTROY code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_DESTROY, adds: 'resource busy' })
  t.is(err.code, 9006, 'Error code should be 9006')
  t.ok(err.message.includes('resource busy'), 'Error message should contain the adds parameter')
})

test('QvacErrorAddonOcr creates error with INVALID_BMP_OR_INSUFFICIENT_DATA code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.INVALID_BMP_OR_INSUFFICIENT_DATA, adds: '/path/to/image.bmp' })
  t.is(err.code, 9007, 'Error code should be 9007')
  t.ok(err.message.includes('/path/to/image.bmp'), 'Error message should contain the file path')
})

test('QvacErrorAddonOcr creates error with INCOMPLETE_BMP_DATA code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.INCOMPLETE_BMP_DATA, adds: '/path/to/truncated.bmp' })
  t.is(err.code, 9009, 'Error code should be 9009')
  t.ok(err.message.includes('/path/to/truncated.bmp'), 'Error message should contain the file path')
})

test('QvacErrorAddonOcr creates error with UNSUPPORTED_BMP_HEADER_SIZE code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.UNSUPPORTED_BMP_HEADER_SIZE, adds: '/path/to/old.bmp' })
  t.is(err.code, 9010, 'Error code should be 9010')
  t.ok(err.message.includes('/path/to/old.bmp'), 'Error message should contain the file path')
})

test('QvacErrorAddonOcr creates error with INVALID_BMP_PIXEL_DATA code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.INVALID_BMP_PIXEL_DATA, adds: '/path/to/bad.bmp' })
  t.is(err.code, 9011, 'Error code should be 9011')
  t.ok(err.message.includes('/path/to/bad.bmp'), 'Error message should contain the file path')
})

test('QvacErrorAddonOcr creates error with MISSING_REQUIRED_PARAMETER code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.MISSING_REQUIRED_PARAMETER, adds: 'langList' })
  t.is(err.code, 9012, 'Error code should be 9012')
  t.ok(err.message.includes('langList'), 'Error message should contain the parameter name')
  t.ok(err.message.includes('Missing required parameter'), 'Error message should contain the base message')
})

test('QvacErrorAddonOcr creates error with UNSUPPORTED_IMAGE_FORMAT code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT, adds: '/path/to/image.gif' })
  t.is(err.code, 9013, 'Error code should be 9013')
  t.ok(err.message.includes('/path/to/image.gif'), 'Error message should contain the file path')
  t.ok(err.message.includes('Supported formats'), 'Error message should mention supported formats')
})

test('QvacErrorAddonOcr creates error with IMAGE_DECODE_FAILED code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.IMAGE_DECODE_FAILED, adds: '/path/to/corrupt.jpg' })
  t.is(err.code, 9014, 'Error code should be 9014')
  t.ok(err.message.includes('/path/to/corrupt.jpg'), 'Error message should contain the file path')
})

test('QvacErrorAddonOcr creates error with UNSUPPORTED_LANGUAGE code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.UNSUPPORTED_LANGUAGE, adds: '["klingon"]' })
  t.is(err.code, 9015, 'Error code should be 9015')
  t.ok(err.message.includes('["klingon"]'), 'Error message should contain the language list')
})

test('QvacErrorAddonOcr creates error with FAILED_TO_RUN_JOB code', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_RUN_JOB, adds: 'timeout exceeded' })
  t.is(err.code, 9016, 'Error code should be 9016')
  t.ok(err.message.includes('timeout exceeded'), 'Error message should contain the adds parameter')
})

/**
 * Test that QvacErrorAddonOcr is an instance of Error.
 */
test('QvacErrorAddonOcr extends Error', async t => {
  const err = new QvacErrorAddonOcr({ code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS, adds: 'test' })
  t.ok(err instanceof Error, 'Should be an instance of Error')
  t.ok(err instanceof QvacErrorAddonOcr, 'Should be an instance of QvacErrorAddonOcr')
})
