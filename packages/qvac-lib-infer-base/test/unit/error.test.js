'use strict'

const test = require('brittle')
const { QvacInferenceBaseError, ERR_CODES } = require('../../src/error')

test('Error codes - NOT_IMPLEMENTED', t => {
  const error = new QvacInferenceBaseError({ code: ERR_CODES.NOT_IMPLEMENTED, adds: 'testMethod' })
  t.is(error.code, ERR_CODES.NOT_IMPLEMENTED, 'error code should match')
  t.is(error.message, 'testMethod function is not implemented', 'error message should be formatted correctly')
})

test('Error codes - LOAD_NOT_IMPLEMENTED', t => {
  const error = new QvacInferenceBaseError({ code: ERR_CODES.LOAD_NOT_IMPLEMENTED, adds: 'getFileSize' })
  t.is(error.code, ERR_CODES.LOAD_NOT_IMPLEMENTED, 'error code should match')
  t.is(error.message, 'getFileSize function is not implemented by the loader', 'error message should be formatted correctly')
})

test('Error codes - ADDON_METHOD_NOT_IMPLEMENTED', t => {
  const error = new QvacInferenceBaseError({ code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED, adds: 'pause' })
  t.is(error.code, ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED, 'error code should match')
  t.is(error.message, 'addon does not implement method pause', 'error message should be formatted correctly')
})

test('Error codes - LOADER_NOT_FOUND', t => {
  const error = new QvacInferenceBaseError({ code: ERR_CODES.LOADER_NOT_FOUND })
  t.is(error.code, ERR_CODES.LOADER_NOT_FOUND, 'error code should match')
  t.is(error.message, 'Loader not found', 'error message should be formatted correctly')
})

test('Error codes - ADDON_INTERFACE_REQUIRED', t => {
  const error = new QvacInferenceBaseError({ code: ERR_CODES.ADDON_INTERFACE_REQUIRED })
  t.is(error.code, ERR_CODES.ADDON_INTERFACE_REQUIRED, 'error code should match')
  t.is(error.message, 'AddonInterface is required for this operation', 'error message should be formatted correctly')
})

test('Error codes - ADDON_NOT_INITIALIZED', t => {
  const error = new QvacInferenceBaseError({ code: ERR_CODES.ADDON_NOT_INITIALIZED })
  t.is(error.code, ERR_CODES.ADDON_NOT_INITIALIZED, 'error code should match')
  t.is(error.message, 'Addon has not been initialized', 'error message should be formatted correctly')
})

test('QvacInferenceBaseError properties', t => {
  const error = new QvacInferenceBaseError({ code: ERR_CODES.NOT_IMPLEMENTED, adds: 'test' })
  t.ok(error instanceof Error, 'should be instance of Error')
  t.is(error.name, 'NOT_IMPLEMENTED', 'error name should match the error code name')
})
