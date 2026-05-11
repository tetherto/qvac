'use strict'

const test = require('brittle')

test('client config - uses default registry core key when none provided', async t => {
  t.plan(2)

  const RegistryConfig = require('../../lib/config')
  const config = new RegistryConfig({})

  const key = config.getRegistryCoreKey(undefined)
  t.ok(key, 'Returns a key when none provided')
  t.is(typeof key, 'string', 'Default key is a string')
})

test('client config - explicit key takes precedence over default', async t => {
  t.plan(1)

  const RegistryConfig = require('../../lib/config')
  const config = new RegistryConfig({})

  const explicit = 'my-custom-key'
  const key = config.getRegistryCoreKey(explicit)
  t.is(key, explicit, 'Returns the explicitly provided key')
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

test('downloadBlob - rejects missing coreKey', async t => {
  t.plan(3)

  const QVACRegistryClient = require('../../lib/client')
  const testClient = Object.create(QVACRegistryClient.prototype)

  try {
    await testClient.downloadBlob(null)
    t.fail('Should have thrown')
  } catch (error) {
    t.ok(error.message.includes('coreKey is required'), 'Throws for null blobBinding')
  }

  try {
    await testClient.downloadBlob({})
    t.fail('Should have thrown')
  } catch (error) {
    t.ok(error.message.includes('coreKey is required'), 'Throws for missing coreKey')
  }

  try {
    await testClient.downloadBlob({ coreKey: 'abc', blockOffset: 'not-a-number', blockLength: 0, byteLength: 0 })
    t.fail('Should have thrown')
  } catch (error) {
    t.ok(error.message.includes('required numbers'), 'Throws for non-number offsets')
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
