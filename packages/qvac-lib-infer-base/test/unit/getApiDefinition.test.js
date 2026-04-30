'use strict'

const test = require('brittle')
const getApiDefinition = require('../../src/utils/getApiDefinition')

test('getApiDefinition - returns a valid API string', t => {
  const result = getApiDefinition()
  const validApis = ['vulkan', 'metal', 'vulkan-32']
  t.ok(validApis.includes(result), `${result} should be a valid API definition`)
})

test('getApiDefinition - matches BaseInference.getApiDefinition()', t => {
  const BaseInference = require('../..')
  const inference = new BaseInference({})

  const standalone = getApiDefinition()
  const instance = inference.getApiDefinition()

  t.is(standalone, instance, 'standalone and instance method should return the same value')
})

test('getApiDefinition - is exported from package root', t => {
  const { getApiDefinition: exported } = require('../..')
  t.is(typeof exported, 'function', 'should be exported as a named function')
  t.is(exported, getApiDefinition, 'should be the same function reference')
})
