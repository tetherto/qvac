'use strict'

const test = require('brittle')
const getApiDefinition = require('../../src/getApiDefinition')

test('getApiDefinition - returns a string', t => {
  const result = getApiDefinition()
  t.is(typeof result, 'string', 'should return a string')
})

test('getApiDefinition - returns a valid API definition', t => {
  const validApis = ['vulkan', 'metal', 'vulkan-32']
  const result = getApiDefinition()
  t.ok(validApis.includes(result), `${result} should be a known API definition`)
})
