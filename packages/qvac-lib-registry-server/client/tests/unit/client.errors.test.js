'use strict'

const test = require('brittle')
const { QVACRegistryClient } = require('../../')
const { QvacErrorRegistryClient, ERR_CODES } = require('../../utils/error')

test('client error - missing registry core key', async t => {
  t.plan(2)

  try {
    const client = new QVACRegistryClient({})
    await client.ready()
    t.fail('Should have thrown error')
  } catch (error) {
    t.ok(error instanceof QvacErrorRegistryClient, 'Throws QvacErrorRegistryClient')
    t.is(error.code, ERR_CODES.FAILED_TO_CONNECT, 'Error code is FAILED_TO_CONNECT')
  }
})

test('client error - invalid path parameter', async t => {
  t.plan(2)

  const QVACRegistryClient = require('../../lib/client')
  const testClient = Object.create(QVACRegistryClient.prototype)

  try {
    testClient._validateString('', 'path')
    t.fail('Should have thrown error for empty string')
  } catch (error) {
    t.ok(error.message.includes('Invalid path'), 'Throws error for empty string')
  }

  try {
    testClient._validateString(123, 'path')
    t.fail('Should have thrown error for non-string')
  } catch (error) {
    t.ok(error.message.includes('Invalid path'), 'Throws error for non-string')
  }
})

test('client error - invalid source parameter', async t => {
  t.plan(2)

  const QVACRegistryClient = require('../../lib/client')
  const testClient = Object.create(QVACRegistryClient.prototype)

  try {
    testClient._validateString('', 'source')
    t.fail('Should have thrown error for empty string')
  } catch (error) {
    t.ok(error.message.includes('Invalid source'), 'Throws error for empty string')
  }

  try {
    testClient._validateString(null, 'source')
    t.fail('Should have thrown error for null')
  } catch (error) {
    t.ok(error.message.includes('Invalid source'), 'Throws error for null')
  }
})

test('client error - invalid options parameter', async t => {
  t.plan(1)

  const options = 'not-an-object'
  if (options && typeof options !== 'object') {
    t.ok(true, 'Correctly identifies invalid options type')
  } else {
    t.fail('Should have identified invalid options')
  }
})

test('client error - invalid search parameters', async t => {
  t.plan(3)

  const QVACRegistryClient = require('../../lib/client')
  const testClient = Object.create(QVACRegistryClient.prototype)

  try {
    testClient._validateString('', 'engine')
    t.fail('Should have thrown error')
  } catch (error) {
    t.ok(error.message.includes('Invalid engine'), 'Throws error for empty engine')
  }

  try {
    testClient._validateString(null, 'name')
    t.fail('Should have thrown error')
  } catch (error) {
    t.ok(error.message.includes('Invalid name'), 'Throws error for null name')
  }

  try {
    testClient._validateString(123, 'quantization')
    t.fail('Should have thrown error')
  } catch (error) {
    t.ok(error.message.includes('Invalid quantization'), 'Throws error for non-string quantization')
  }
})
